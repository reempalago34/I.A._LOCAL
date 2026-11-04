# Forge Local

Asistente de código autoalojado para modelos locales y privados. Conversa con un LLM
ejecutado en tu propia máquina o servidor, selecciona explícitamente los archivos que
forman el contexto, revisa cada cambio propuesto y aplica solo lo que apruebes.

Forge Local no envía telemetría, no indexa tu proyecto automáticamente y no ejecuta
comandos sin confirmación.

## Características

- **Chat de código** con Markdown, resaltado de sintaxis, copia de respuestas, varias
  conversaciones, cancelación y reintento.
- **Contexto explícito**: eliges archivos del proyecto, ves el contenido exacto y el
  tamaño estimado antes de enviarlo. No hay indexado ni escaneo automático.
- **Propuestas revisables**: el modelo devuelve bloques `<proposal>`; la aplicación los
  convierte en diffs, permite aceptar o rechazar cada propuesta y crea un backup antes
  de escribir.
- **Comandos bajo control**: el modelo puede sugerir comandos, pero nunca se ejecutan
  solos. La ejecución está desactivada por defecto y, si se habilita, usa una allowlist
  de comandos completos, denegaciones para `node -e`/`npx`/instalaciones de npm/git
  peligroso, `shell: false`, timeout y límite de salida.
- **Ollama primero**: adaptador desacoplado del runtime, URL y modelo configurables,
  estimación orientativa de RAM/disco y errores claros.
- **Seguridad por defecto**: Argon2id, sesiones opacas en SQLite, cookies `HttpOnly` /
  `Secure` / `SameSite`, CSRF, validación de `Origin`, rate limiting, bloqueo de login,
  cabeceras CSP/HSTS y contenedores sin root.
- **Privacidad**: historial desactivado por defecto, archivos nunca guardados en la base
  de datos, logs sin prompts ni código, borrado de historial/backups desde la UI.
- **Despliegue**: Dockerfile multi-stage, Docker Compose con Ollama en red privada,
  volúmenes persistentes, healthchecks, límites de recursos y guía para Coolify.
- **Cliente ligero**: indicador visible “Este computador” / “Servidor remoto”, límites
  de contexto reducidos, lectura de archivos por fragmentos, cálculo y borrado del
  espacio usado, y comprobación de recursos antes de usar inferencia local.

## Perfil de hardware recomendado

El diseño prioriza un cliente modesto (por ejemplo, un portátil con 4 GB de RAM) y la
inferencia en un **servidor privado desplegado con Coolify**:

- El navegador y la app cliente solo muestran la interfaz y envían lo que autorizas.
- No se incluyen modelos ni se descargan automáticamente.
- La ejecución local queda como opción **experimental**: la app comprueba RAM, disco y
  requisitos del runtime/modelo, y avisa de que con 4 GB puede ser lenta o no caber.
- No se asume que el servidor tenga GPU: la comprobación consulta `ollama ps` y muestra
  la VRAM reportada, sin garantizar que un modelo concreto funcione.

Configura `DEPLOYMENT_MODE=server` en Coolify para que la interfaz muestre
“Servidor remoto”. En un equipo local con Ollama en `127.0.0.1` se muestra
“Este computador”.

## Stack

| Capa | Tecnología |
| --- | --- |
| Frontend | React 19, Vite 8, TypeScript estricto, CSS propio |
| Backend | Node.js 22, Fastify 5, TypeScript estricto, Zod |
| Persistencia | SQLite (`better-sqlite3`), WAL |
| Autenticación | `@node-rs/argon2` (Argon2id), sesiones opacas |
| Runtime | Ollama (API HTTP/streaming) |
| Tests | Vitest (backend y frontend) |
| Lint/format | Biome |

## Inicio rápido local

### Requisitos

- Node.js `>=22.12 <23` y npm 10+.
- Un runtime Ollama accesible. Para el equipo cliente se recomienda apuntar a un
  servidor remoto; la inferencia local solo es experimental en 4 GB de RAM.
- Consulta [hardware y modelos](docs/local-development.md#hardware-y-modelos). No se
  presenta ningún modelo concreto como compatible: revisa sus requisitos actuales.

> En un equipo con 4 GB de RAM, usa preferentemente el servidor de Coolify. Levantar
> Ollama, el modelo y la interfaz a la vez puede agotar la memoria.

### 1. Dependencias y configuración

```bash
npm ci
cp .env.example .env
```

Revisa `.env`. Para desarrollo local los valores por defecto funcionan; si no defines
`SESSION_SECRET`, se genera uno efímero y las sesiones se pierden al reiniciar.

### 2. Runtime y modelo

```bash
ollama serve              # solo si vas a probar inferencia local
ollama list               # modelos ya instalados
# En el servidor remoto, tras comprobar tamaño y requisitos actuales:
# ollama pull <modelo>
```

La aplicación **no descarga ni arranca modelos**. Si Ollama no está disponible, la UI
muestra el error de conexión. En Ajustes puedes usar **Comprobar recursos** para ver
RAM/CPU/disco del host, modelos cargados y evidencia de GPU reportada por Ollama.

### 3. Arranque

```bash
npm run dev
```

- UI: <http://127.0.0.1:5173>
- API: <http://127.0.0.1:8080>
- Salud: `/healthz` y `/readyz`

### 4. Primera cuenta

El registro público está desactivado. Crea una cuenta desde la CLI:

```bash
npm run build
npm run create-admin -- --email tu@correo.com --admin
```

La CLI pide la contraseña de forma interactiva (mínimo 12 caracteres). También puedes
usar `--random` para generar una y mostrarla una sola vez. En desarrollo, como
alternativa, define `ALLOW_REGISTRATION=true` temporalmente y desactívalo después.

### 5. Proyectos

Los proyectos deben existir dentro de `PROJECTS_ROOT` (por defecto
`~/ForgeProjects`). Copia o clona allí los repositorios y selecciona la carpeta desde
la UI:

```bash
mkdir -p ~/ForgeProjects
cp -r /ruta/a/mi-repo ~/ForgeProjects/mi-repo
```

No se suben archivos desde el navegador ni se indexan carpetas. La app solo lee los
archivos que selecciones y escribe únicamente cuando aceptas una propuesta.

## Docker Compose

```bash
cp .env.example .env
# Edita .env y define como mínimo:
#   SESSION_SECRET=$(openssl rand -base64 48)
#   PUBLIC_ORIGIN=https://forge.example.com   (o http://localhost:8080 en local)
docker compose up -d --build

docker compose exec ollama ollama pull <modelo>
docker compose exec forge node apps/server/dist/cli/create-user.js --admin --email tu@correo.com
```

La UI queda en <http://127.0.0.1:8080>. El puerto está publicado solo en loopback;
para exponerlo usa un proxy inverso con HTTPS (Coolify/Traefik, Caddy, nginx) o un
túnel SSH. Ollama no publica puertos: solo es accesible desde la red interna.

Con GPU NVIDIA:

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
```

Las instrucciones completas, incluida la configuración de Coolify, están en
[docs/coolify.md](docs/coolify.md).

## Cómo funciona el flujo de cambios

1. El modelo responde en Markdown y puede incluir propuestas:
   `<proposal path="src/app.ts" action="write">...</proposal>`.
2. El backend valida rutas, tamaños y exclusiones, calcula el diff y guarda la propuesta
   **en memoria** con TTL.
3. La UI muestra el diff. Al aceptar, se crea un backup en `DATA_DIR/backups`, se escribe
   de forma atómica y se verifica el hash posterior.
4. Puedes restaurar el backup desde “Backups” o borrar los datos desde “Privacidad”.

Las propuestas no sobreviven a un reinicio del servidor. Los backups temporales caducan
según `BACKUP_RETENTION_DAYS`.

## Almacenamiento y memoria

- `MAX_STORAGE_BYTES` limita por usuario los datos persistidos (conversaciones y copias
  temporales). Por defecto 64 MiB; cada usuario puede bajarlo desde Ajustes.
- Ajustes muestra conversaciones, copias, temporales, caché en memoria, base de datos y
  disco libre, y permite borrar historial, backups o temporales con confirmación.
- Los archivos de contexto se leen por fragmentos, se limitan con `MAX_FILE_BYTES`,
  `MAX_CONTEXT_BYTES` y `MAX_CONTEXT_FILES`, y se liberan al terminar cada generación.
- No se indexa el proyecto ni se guardan contenidos de archivos en SQLite.
- Si se alcanza el límite, la app rechaza guardar más datos (`STORAGE_LIMIT_EXCEEDED`).

## Scripts

| Comando | Descripción |
| --- | --- |
| `npm run dev` | Backend con recarga + Vite en paralelo |
| `npm run build` | Compila frontend y backend |
| `npm start` | Ejecuta el backend compilado |
| `npm test` | Tests de backend y frontend |
| `npm run typecheck` | TypeScript estricto en ambos workspaces |
| `npm run lint` | Biome (lint + formato) |
| `npm run format` | Aplica formato con Biome |
| `npm run create-admin` | Crea/actualiza una cuenta administradora |
| `npm run create-user` | Crea una cuenta normal |
| `npm run test:coverage` | Cobertura del backend |

## Documentación

- [Arquitectura](docs/architecture.md): componentes, datos, flujos y API.
- [Seguridad](docs/security.md): modelo de amenazas, controles y límites.
- [Coolify](docs/coolify.md): despliegue paso a paso con HTTPS y volúmenes.
- [Desarrollo local y modelos](docs/local-development.md): runtime, modelos, hardware y
  solución de problemas.
- [Operaciones](docs/operations.md): backups, restauración, actualizaciones y borrado.

## Límites conocidos

- La imagen Docker y el compose no se construyeron en el entorno donde se desarrolló el
  proyecto (no había Docker disponible). Se validaron de forma estática con tests; haz
  un despliegue de prueba antes de confiar en ellos.
- No hay aislamiento de sistema de archivos por usuario: cualquier cuenta autenticada
  puede seleccionar cualquier carpeta bajo `PROJECTS_ROOT`. Está pensado para un equipo
  pequeño y de confianza, no para multitenencia hostil.
- La ejecución de comandos no usa contenedores aislados; cuando se habilita, corre con
  el usuario del proceso y puede modificar el proyecto. La imagen de runtime no incluye
  `git`; si lo necesitas, crea una imagen derivada.
- Solo se implementa el adaptador de Ollama. La interfaz `ModelRuntime` está preparada
  para añadir otros runtimes compatibles.
- Las estimaciones de hardware son orientativas y no miden tu GPU real. No se garantiza
  que un modelo concreto funcione, especialmente en un equipo de 4 GB de RAM.
- La comprobación de recursos del servidor remoto solo puede basarse en lo que expone
  Ollama; no inspecciona la máquina anfitriona ni confirma que haya GPU.
- El límite de almacenamiento se aplica a datos de la app; no controla el espacio que
  ocupan los modelos de Ollama, que se gestionan aparte.
- El proyecto no incluye integración con Git (diffs de working tree, commits, PRs).

## Licencia

MIT. Consulta [LICENSE](LICENSE).
