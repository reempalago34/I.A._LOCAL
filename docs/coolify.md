# Despliegue en Coolify

Esta guía despliega Forge Local y Ollama como un único recurso **Docker Compose** en
Coolify, con HTTPS gestionado por el proxy de Coolify. Ollama queda en una red privada,
sin dominio y sin puerto público.

> Coolify cambia de interfaz con frecuencia. Los nombres pueden variar ligeramente; lo
> importante es que el resultado sea: app con dominio HTTPS, Ollama sin dominio, dos
> volúmenes persistentes y las variables de entorno indicadas.

## Requisitos

- Un servidor con Coolify instalado y funcionando.
- Docker y Docker Compose accesibles desde Coolify.
- Un dominio (por ejemplo `forge.example.com`) con DNS apuntando al servidor.
- Repositorio Git con este proyecto (el compose usa `build: .`).
- Memoria suficiente para el modelo en el servidor. No se asume GPU ni una cantidad
  concreta: comprueba `free -h`, `ollama ps` y la ficha actual del modelo. Los modelos
  grandes pueden requerir mucha más RAM/VRAM que el propio contenedor.
- Opcional: GPU NVIDIA con NVIDIA Container Toolkit para acelerar Ollama. La app no
  puede confirmar por sí sola que exista GPU; solo muestra la VRAM que reporta Ollama.
- El cliente puede ser un equipo modesto (por ejemplo, 4 GB de RAM): solo ejecuta la
  interfaz. La generación ocurre en este servidor.

## 1. Prepara el repositorio

Sube el proyecto a un repositorio accesible por Coolify. El archivo
`docker-compose.yml` ya incluye:

- `forge`: build del Dockerfile, usuario no root, FS de solo lectura, puerto en loopback,
  healthcheck y límites.
- `ollama`: imagen fijada, sin `ports`, solo `expose` en la red `runtime`, volumen de
  modelos y healthcheck.
- Volúmenes `forge-data`, `forge-projects` y `ollama-models`.

No incluyas `.env`, datos ni claves en el repositorio.

## 2. Crea el recurso en Coolify

1. Entra en tu **Project** y entorno.
2. **+ New Resource** → **Docker Compose** (o “Docker Compose Application”, según la
   versión).
3. Conecta el repositorio y selecciona la rama.
4. Base directory: `/` (raíz del repo).
5. Docker Compose location: `/docker-compose.yml`.
6. Guarda y deja que Coolify analice el compose.

## 3. Configura las variables de entorno

En **Environment Variables** del recurso, define como mínimo:

| Variable | Valor |
| --- | --- |
| `SESSION_SECRET` | Cadena aleatoria de ≥32 caracteres. Genera con `openssl rand -base64 48`. |
| `PUBLIC_ORIGIN` | `https://forge.example.com` (sin barra final). |
| `TRUST_PROXY` | `true` (Coolify pone un proxy delante). |
| `FORGE_HOST_PORT` | Opcional. Puerto local; cámbialo si 8080 está ocupado. |
| `FORGE_MEMORY_LIMIT` | `1g` por defecto. |
| `OLLAMA_MEMORY_LIMIT` | `12g` por defecto; ajústalo a tu RAM/VRAM. |
| `OLLAMA_CPUS` | `4.0` por defecto. |
| `OLLAMA_KEEP_ALIVE` | `10m` por defecto; `0` descarga el modelo tras cada uso. |

El compose fija deliberadamente:

```yaml
ALLOW_REGISTRATION: "false"
ENABLE_COMMAND_EXECUTION: "false"
ALLOW_CUSTOM_RUNTIME: "false"
DEPLOYMENT_MODE: server
OLLAMA_BASE_URL: http://ollama:11434
RUNTIME_ALLOWED_HOSTS: ollama
RUNTIME_ALLOWED_PORTS: "11434"
```

`DEPLOYMENT_MODE=server` hace que la interfaz muestre “Servidor remoto”. No cambies
`OLLAMA_BASE_URL` a `localhost`: dentro del contenedor de Forge, `localhost` es Forge,
no Ollama.

Guarda `SESSION_SECRET` como secreto en Coolify y no lo reutilices en otros servicios.
Cambiarlo invalida todas las sesiones.

## 4. Dominio y HTTPS

El servicio `forge` escucha en el puerto interno **8080**. Tienes dos formas de enrutar:

### Opción A: campo Domains de Coolify (recomendada)

1. Abre el servicio `forge` dentro del recurso Compose.
2. En **Domains** / **General**, define `https://forge.example.com` y el puerto interno
   `8080`.
3. Redespliega y espera a que el proxy emita el certificado.
4. Comprueba que `PUBLIC_ORIGIN` coincide **exactamente** con la URL final (esquema,
   dominio y sin barra final).

### Opción B: variable mágica de Compose

Coolify reconoce variables como `SERVICE_FQDN_FORGE_8080` y genera el dominio/routing.
En el compose, dentro de `services.forge.environment`, descomenta o añade:

```yaml
SERVICE_FQDN_FORGE_8080: ""
```

Vuelve a desplegar y revisa el dominio generado en **Environment Variables** / **Domains**.
Ajusta el dominio al tuyo y actualiza `PUBLIC_ORIGIN`.

No asignes ningún dominio a `ollama`. No publiques su puerto. El contenedor de Ollama
solo debe ser alcanzable desde `forge` por la red `runtime`.

## 5. Volúmenes persistentes

Coolify muestra los volúmenes del compose en **Persistent Storages**, pero son de solo
lectura en la UI: la fuente de verdad es el compose. No los borres al actualizar.

| Volumen | Destino | Contenido |
| --- | --- | --- |
| `forge-data` | `/data` | SQLite, backups temporales, temporales de comandos |
| `forge-projects` | `/projects` | Repositorios que verá la app |
| `ollama-models` | `/root/.ollama` | Modelos descargados |

El volumen `forge-projects` empieza vacío. Para trabajar con repositorios existentes,
la opción más sencilla es usar un bind mount a una carpeta del servidor:

```yaml
services:
  forge:
    volumes:
      - /srv/forge/projects:/projects
      - forge-data:/data
```

Requisitos:

```bash
sudo mkdir -p /srv/forge/projects
sudo chown -R 1000:1000 /srv/forge/projects
# Copia o clona tus repositorios dentro de /srv/forge/projects
```

El contenedor corre con UID/GID 1000 (`node`). Si los permisos no son correctos, la app
no podrá leer ni escribir. No montes `/`, el home del host ni directorios con secretos.

También puedes mantener el volumen gestionado y copiar contenido con `docker cp` desde
el host, pero un bind mount es más fácil de administrar y respaldar.

## 6. Despliega

1. Pulsa **Deploy**.
2. Revisa los logs de build y arranque.
3. Espera a que `forge` esté `healthy`. El healthcheck ejecuta `/readyz`, que comprueba
   SQLite y la raíz de proyectos.
4. Abre `https://forge.example.com`. Debe cargar la pantalla de acceso.

Si el proxy devuelve 502/404:

- verifica que el dominio apunta al servicio `forge` y al puerto **8080**;
- revisa que el contenedor esté healthy;
- comprueba los logs de `forge`;
- confirma que `PUBLIC_ORIGIN` y el dominio coinciden.

## 7. Descarga un modelo

En Coolify abre la **Terminal** del servicio `ollama` y ejecuta:

```bash
ollama pull <modelo>:<etiqueta>
ollama list
```

Elige el modelo según la RAM/VRAM real del servidor y su ficha actual; no hay un modelo
“compatible por defecto”. Antes de descargar, comprueba el espacio libre y el tamaño
aproximado. El volumen `ollama-models` conserva los modelos entre despliegues. La
descarga necesita salida a Internet; la red `runtime` no es `internal` precisamente para
permitirlo. No publiques el puerto 11434.

Para ver el consumo y confirmar si hay VRAM en uso:

```bash
ollama ps
free -h
nvidia-smi   # solo si el servidor tiene GPU NVIDIA
```

En la UI, entra en **Ajustes → Comprobar recursos**. La comprobación muestra RAM/CPU y
disco del host de Forge, modelos cargados y la VRAM que reporta Ollama. No puede leer la
máquina anfitriona completa ni garantizar que un modelo concreto funcione; si no hay
modelos cargados, la GPU aparecerá como “no confirmada”.

## 8. Crea la primera cuenta

El registro público está desactivado. En la **Terminal** del servicio `forge`:

```bash
node apps/server/dist/cli/create-user.js --admin --email tu@correo.com --random
```

El comando imprime una contraseña generada una sola vez. Guárdala en tu gestor de
contraseñas e inicia sesión. Si la terminal es interactiva, puedes omitir `--random` y
te pedirá la contraseña.

Para crear una cuenta normal:

```bash
node apps/server/dist/cli/create-user.js --email companero@correo.com --random
```

Para cambiar una contraseña existente:

```bash
node apps/server/dist/cli/create-user.js --email tu@correo.com --update --random
```

## 9. Verificación posterior al despliegue

- [ ] HTTPS válido y redirección desde HTTP.
- [ ] `PUBLIC_ORIGIN` coincide con la URL del navegador.
- [ ] Cookies `forge_sid` y `forge_csrf` con `Secure` (revisa DevTools).
- [ ] Registro público deshabilitado (`/api/auth/config` → `registrationEnabled: false`).
- [ ] Ollama sin dominio ni puerto público.
- [ ] El selector de modelos lista el modelo descargado.
- [ ] Una consulta simple responde por streaming.
- [ ] Los archivos de contexto se previsualizan antes de enviar.
- [ ] Una propuesta genera diff; aceptar crea backup; restaurar funciona.
- [ ] Reiniciar el recurso conserva usuarios, ajustes, backups y modelos.
- [ ] Los logs no muestran prompts, código, cookies ni tokens.

## 10. Actualizaciones

1. Haz un backup de `forge-data` y del bind mount de proyectos.
2. Actualiza el repositorio y redespliega.
3. Las migraciones de SQLite son automáticas al arrancar (versión de esquema actual: 1).
4. Verifica `/readyz`, inicia sesión y prueba una consulta.
5. Para actualizar Ollama, cambia la etiqueta de imagen de forma deliberada y redespliega;
   los modelos del volumen se conservan, pero revisa compatibilidad.

No uses `latest` en producción. El compose fija `forge-local:1.0.0` y
`ollama/ollama:0.40.13`; cambia las versiones de forma controlada.

## 11. GPU en Coolify

El host debe tener el NVIDIA Container Toolkit y el runtime `nvidia` configurado. Añade
al servicio `ollama` del compose la reserva de dispositivo:

```yaml
services:
  ollama:
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
```

O usa una rama con el contenido de `docker-compose.gpu.yml` fusionado. Redespliega y
comprueba con:

```bash
nvidia-smi
ollama ps
```

## 12. Alternativa: recursos separados

Si tu organización no permite Compose, puedes desplegar:

1. Forge Local como **Application** con build por Dockerfile, dominio HTTPS y volúmenes
   `/data` y `/projects`.
2. Ollama como **Docker Image** (`ollama/ollama:0.40.13`) **sin dominio** y con volumen
   `/root/.ollama`.
3. Conectar ambos contenedores a una red Docker compartida y usar
   `OLLAMA_BASE_URL=http://<nombre-del-contenedor-ollama>:11434`.

Esta variante depende de cómo Coolify conecte redes; es más frágil que el compose único.
Si la usas, verifica que Forge resuelve el nombre del contenedor y que Ollama no tiene
ningún puerto publicado.

## Problemas frecuentes en Coolify

| Síntoma | Causa probable | Solución |
| --- | --- | --- |
| 502 Bad Gateway | Dominio al puerto incorrecto o contenedor unhealthy | Dominio → servicio `forge` → puerto 8080; revisa `/readyz`. |
| Login no persiste | `PUBLIC_ORIGIN` no coincide o cookies no seguras | Corrige el origen, `TRUST_PROXY=true`, HTTPS. |
| `403 Origen no permitido` | `PUBLIC_ORIGIN` con esquema/dominio distinto | Usa la URL exacta, sin barra final. |
| `403 RUNTIME_HOST_NOT_ALLOWED` | URL de Ollama no permitida | Usa `http://ollama:11434` y `RUNTIME_ALLOWED_HOSTS=ollama`. |
| Ollama no descarga modelos | Sin salida a Internet o disco lleno | Revisa red del servidor y espacio en `ollama-models`. |
| No aparecen proyectos | `/projects` vacío o permisos incorrectos | Bind mount con UID 1000 y repositorios dentro. |
| La app reinicia en bucle | `SESSION_SECRET` ausente o inválido | Define el secreto y revisa logs. |
| Se pierde todo al redesplegar | Volúmenes no declarados o cambiados | Mantén los volúmenes del compose; no los borres. |

Para más detalle: [operaciones](operations.md) y [seguridad](security.md).
