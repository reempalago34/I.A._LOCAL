# Operaciones

Guía práctica para mantener, respaldar, restaurar, actualizar, limitar datos y apagar
Forge Local correctamente.

## Checklist diario / semanal

- [ ] Revisar `/readyz` y `/healthz`.
- [ ] Comprobar logs de `forge` y `ollama` (sin contenido sensible).
- [ ] Vigilar espacio en disco en `forge-data`, `forge-projects` y `ollama-models`.
- [ ] Verificar que los backups no superen `BACKUP_RETENTION_DAYS`.
- [ ] Revisar usuarios registrados (CLI o base de datos).
- [ ] Mantener `ENABLE_COMMAND_EXECUTION` desactivado salvo uso planificado.

## Logs

El backend registra solo metadatos. Fastify redacta cookies, CSRF, `authorization` y
`set-cookie`. No se registra ningún prompt, código, archivo, respuesta del modelo, token
CSRF, token de sesión ni contraseña. Si habilitas `ENABLE_COMMAND_EXECUTION`, la ruta
`/api/commands/execute` registra `userId`, `projectId`, `exitCode`, `timedOut` y
`durationMs`; el comando y su salida **no** se incluyen.

Para ver logs:

```bash
# Docker Compose
docker compose logs -f --tail=100 forge
docker compose logs -f --tail=100 ollama

# Coolify
# Terminal del servicio `forge` o la vista de logs del recurso.
```

## Copias de seguridad

**Importante:** los backups automáticos de Coolify no siempre incluyen bind mounts
personalizados; verifica tu configuración.

### Qué respaldar

| Elemento | Importancia | Comentario |
| --- | --- | --- |
| `forge-data` (`/data`) | Crítica | SQLite, usuarios, ajustes, historial y backups temporales. |
| `forge-projects` (`/projects`) | Crítica | Tu código; normalmente ya está en Git, pero respáldalo. |
| `ollama-models` (`/root/.ollama`) | Media | Se puede volver a descargar; ahorra tiempo y ancho de banda. |
| Variables de entorno / secretos | Crítica | `SESSION_SECRET`, `PUBLIC_ORIGIN`, tokens. Guárdalos en un gestor. |

### Backup con el contenedor detenido (consistente)

Con Docker Compose, el proyecto se llama `forge-local`, así que los volúmenes suelen
llamarse `forge-local_forge-data`, etc. Confirma los nombres:

```bash
docker compose config --volumes
docker volume ls | grep forge
```

Procedimiento:

```bash
docker compose stop forge
mkdir -p backups
docker run --rm \
  -v forge-local_forge-data:/data:ro \
  -v "$PWD/backups":/backup \
  alpine tar czf /backup/forge-data-$(date +%F-%H%M).tgz -C /data .
docker compose start forge
```

Para los proyectos:

```bash
docker run --rm \
  -v forge-local_forge-projects:/projects:ro \
  -v "$PWD/backups":/backup \
  alpine tar czf /backup/forge-projects-$(date +%F-%H%M).tgz -C /projects .
```

Si usas bind mounts (`/srv/forge/projects`), respalda esa carpeta con tu herramienta
habitual.

### Backup en caliente de SQLite

SQLite está en modo WAL. Copiar `forge.sqlite` a mano con la app en marcha puede producir
una copia inconsistente. Lo más seguro es detener `forge` o usar la API de backup de
`better-sqlite3`:

```bash
docker compose exec -T forge node --input-type=module -e "
import Database from 'better-sqlite3';
const db = new Database('/data/forge.sqlite');
await db.backup('/data/forge.sqlite.bak');
db.close();
"
docker compose cp forge:/data/forge.sqlite.bak ./backups/forge-$(date +%F-%H%M).sqlite
```

Después puedes borrar el `.bak` del volumen. Comprueba la integridad:

```bash
sqlite3 ./backups/forge-2026-01-01-1200.sqlite 'PRAGMA integrity_check;'
```

### Backup de los backups temporales

`DATA_DIR/backups` contiene el contenido de los archivos originales para poder deshacer
propuestas. Se incluye en el tar de `forge-data`. No sustituye a un backup del proyecto:
caduca según `BACKUP_RETENTION_DAYS`.

### Restauración

1. Detén la app:

   ```bash
   docker compose stop forge
   ```

2. Guarda el volumen actual (por si acaso):

   ```bash
   docker run --rm -v forge-local_forge-data:/data:ro -v "$PWD/backups":/backup \
     alpine tar czf /backup/forge-data-antes-restaurar-$(date +%F-%H%M).tgz -C /data .
   ```

3. Restaura el tar:

   ```bash
   docker run --rm -v forge-local_forge-data:/data -v "$PWD/backups":/backup \
     alpine sh -c 'rm -rf /data/* && tar xzf /backup/forge-data-2026-01-01-1200.tgz -C /data'
   ```

4. Arranca y verifica:

   ```bash
   docker compose start forge
   curl -fsS http://127.0.0.1:8080/readyz
   ```

5. Inicia sesión y comprueba proyectos, ajustes y backups. Las sesiones existentes
   siguen siendo válidas si el `SESSION_SECRET` no cambió.

Prueba la restauración al menos una vez antes de necesitarla de verdad.

## Actualizaciones

1. Anuncia la ventana de mantenimiento.
2. Haz backup de `forge-data` y de los proyectos.
3. Actualiza el repositorio y las etiquetas de imagen de forma deliberada.
4. Redespliega:

   ```bash
   docker compose build --pull
   docker compose up -d
   ```

5. Comprueba logs, `/readyz`, login y una consulta con streaming.
6. Verifica que los volúmenes siguen montados y que los datos están presentes.

Las migraciones de SQLite se ejecutan al arrancar y son idempotentes para la versión
actual del esquema. Antes de una actualización mayor, revisa las notas del proyecto y
haz un backup verificable.

### Actualizar modelos

```bash
docker compose exec ollama ollama list
docker compose exec ollama ollama pull <modelo>
docker compose exec ollama ollama rm <modelo-antiguo>
```

Eliminar un modelo libera disco, pero los usuarios que lo tengan seleccionado recibirán
un error hasta que elijan otro.

## Rotación de secretos

### `SESSION_SECRET`

Cambiarlo invalida todas las sesiones y los hashes HMAC de intentos de login. Es la
acción recomendada si sospechas que se filtró.

```bash
# Edita .env o la variable en Coolify
docker compose up -d forge
```

Los usuarios deberán iniciar sesión de nuevo. No cambies el secreto sin avisar.

### `OLLAMA_AUTH_TOKEN`

Si Ollama está detrás de un proxy con token, rota el token en ambos lados y reinicia
`forge`. El token nunca se envía al navegador.

### Contraseñas de usuarios

```bash
docker compose exec forge node apps/server/dist/cli/create-user.js \
  --email usuario@correo.com --update --random
```

El comando cierra las demás sesiones de esa cuenta. Para crear una cuenta nueva, usa la
misma CLI sin `--update`.

## Gestión de usuarios

No hay panel de administración. Las cuentas se gestionan con la CLI:

```bash
# Crear administrador (contraseña aleatoria mostrada una vez)
docker compose exec forge node apps/server/dist/cli/create-user.js \
  --admin --email admin@correo.com --random

# Crear usuario normal
docker compose exec forge node apps/server/dist/cli/create-user.js \
  --email dev@correo.com --random

# Actualizar contraseña
docker compose exec forge node apps/server/dist/cli/create-user.js \
  --email dev@correo.com --update --random
```

El registro público debe permanecer desactivado (`ALLOW_REGISTRATION=false`). No existe
borrado de usuarios desde la UI en esta versión; si necesitas eliminar una cuenta,
detén la app, haz un backup y elimina la fila con `sqlite3` respetando las claves
foráneas (`ON DELETE CASCADE`). Es una operación manual y destructiva.

## Privacidad y borrado de datos

Desde **Privacidad** puedes borrar:

- historial de conversaciones;
- backups temporales;
- ambos.

Requiere escribir `BORRAR`. El borrado es inmediato en SQLite y en `DATA_DIR/backups`.
No borra los archivos del proyecto ni los modelos de Ollama.

Para borrar todo el estado de la instancia, detén el servicio y elimina el volumen
`forge-data`. **Es irreversible.** Los proyectos y modelos están en volúmenes distintos.

## Salud y diagnóstico

```bash
curl -fsS http://127.0.0.1:8080/healthz   # proceso vivo
curl -fsS http://127.0.0.1:8080/readyz    # SQLite + PROJECTS_ROOT
docker compose ps
docker stats --no-stream forge-local-forge-1 forge-local-ollama-1
```

`/healthz` no comprueba dependencias; `/readyz` sí comprueba SQLite y la raíz de
proyectos, pero no Ollama. La salud de Ollama se consulta desde la UI o con:

```bash
curl -fsS http://127.0.0.1:11434/api/tags  # solo desde el host, si está permitido
docker compose exec ollama ollama list
```

En Docker Compose, Ollama no está publicado, así que el `curl` al 11434 desde el host
puede fallar. Es lo esperado; usa `docker compose exec`.

## Capacidad y rendimiento

- **RAM**: el modelo y la caché KV dominan el consumo. Ajusta `OLLAMA_MEMORY_LIMIT` y
  `OLLAMA_CPUS`; si el contenedor muere por OOM, reduce el modelo o aumenta la memoria.
- **VRAM**: con GPU, Ollama intenta cargar capas en VRAM. Si no cabe, parte del modelo
  va a CPU y baja la velocidad. Revisa `ollama ps`.
- **Disco**: cada modelo puede ocupar varios GB. `ollama list` muestra tamaños. Deja
  margen para SQLite/WAL y backups.
- **Concurrencia**: Forge limita a una generación por usuario y Ollama a un modelo
  cargado (`OLLAMA_MAX_LOADED_MODELS=1`). Para más usuarios, usa un servidor de inferencia
  dedicado (vLLM, llama.cpp server, etc.) y adapta el runtime.
- **SQLite**: un escritor. Si aumentan mucho las conversaciones, archiva o borra historial
  y considera un motor cliente-servidor en el futuro.
- **Almacenamiento por usuario**: `MAX_STORAGE_BYTES` (64 MiB por defecto) limita
  conversaciones + copias temporales. `GET /api/storage` informa del uso y
  `DELETE /api/storage/temp` (con `{"confirmation":"BORRAR"}`) borra temporales y
  propuestas en memoria. El usuario puede bajar su límite y borrar datos desde Ajustes.
- **Cliente ligero**: el equipo que solo muestra la interfaz no debe ejecutar Ollama ni
  modelos grandes. Comprueba su RAM y disco con **Ajustes → Comprobar recursos**; la
  generación debe ocurrir en el servidor (`DEPLOYMENT_MODE=server`).

## Apagado y arranque

```bash
docker compose stop        # conserva contenedores y volúmenes
docker compose down        # elimina contenedores; los volúmenes nombrados se conservan
docker compose down -v     # ¡BORRA también los volúmenes! Solo para reinicio total
```

La app maneja `SIGTERM`/`SIGINT`, cierra Fastify y SQLite y tiene un límite de 12 s antes
de forzar la salida. `stop_grace_period: 15s` da margen suficiente.

## Recuperación ante desastres

1. Aprovisiona un servidor con Docker y Coolify.
2. Restaura el repositorio y las variables de entorno (incluido `SESSION_SECRET`).
3. Restaura `forge-data` y los proyectos.
4. Levanta el stack, descarga los modelos o restaura `ollama-models`.
5. Comprueba `/readyz`, login, una consulta y la restauración de un backup.

Si perdiste `SESSION_SECRET`, puedes generar uno nuevo: los usuarios deberán iniciar
sesión otra vez, pero los datos y contraseñas siguen siendo válidos.

## Limitaciones operativas conocidas

- Sin panel de administración ni borrado de usuarios por UI.
- Sin backups automáticos integrados en la app; usa el sistema de volúmenes/Coolify.
- Las propuestas viven en memoria: un reinicio las pierde.
- La imagen de runtime no incluye `git`; la ejecución de comandos con `git` requiere una
  imagen derivada.
- Ollama necesita salida a Internet para descargar modelos; la red `runtime` no es
  `internal` para permitirlo. No publiques su puerto.
