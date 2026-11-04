# Desarrollo local, modelos y hardware

## Requisitos

- Node.js `>=22.12 <23` (la imagen usa `22.23.4`).
- npm 10+.
- Ollama instalado y funcionando, o un servidor Ollama accesible.
- Linux, macOS o Windows con WSL2. La app está probada principalmente en Linux.

Instala dependencias:

```bash
npm ci
cp .env.example .env
```

`npm ci` compila `better-sqlite3` si no hay binario precompilado para tu plataforma.
Necesitas Python 3 y un compilador C++ en ese caso.

## Arranque en desarrollo

```bash
npm run dev
```

- Vite: <http://127.0.0.1:5173> (proxy `/api`, `/healthz` y `/readyz` a 8080).
- Fastify: <http://127.0.0.1:8080>.
- El backend recarga con `tsx watch`; el frontend con HMR.

Para probar el build de producción en local:

```bash
npm run build
NODE_ENV=production SESSION_SECRET="$(openssl rand -base64 48)" \
  PUBLIC_ORIGIN=http://127.0.0.1:8080 TRUST_PROXY=false npm start
```

La app sirve `apps/web/dist` desde el mismo puerto.

## Configuración de Ollama

### Instalación

Sigue la guía oficial de <https://ollama.com/download>. En Linux, el instalador suele
dejar un servicio systemd escuchando en `127.0.0.1:11434`.

Verifica:

```bash
curl -s http://127.0.0.1:11434/api/tags
ollama list
```

### Descargar un modelo

Forge Local **no descarga ni arranca modelos**. Hazlo tú, después de comprobar el tamaño
y los requisitos actuales del modelo en su ficha:

```bash
ollama pull <modelo>:<etiqueta>
ollama list
```

No se presenta ningún modelo concreto como compatible. Los modelos pequeños y
cuantizados (por ejemplo, variantes de 1-4B en Q4) son los únicos que podrían intentarse
en un equipo con 4 GB de RAM, y aun así pueden ser lentos o no caber junto al sistema.
La calidad y la ventana de contexto serán limitadas. Para uso real, ejecuta el modelo en
el servidor remoto.

La aplicación muestra el tamaño, la cuantización y una estimación de RAM en el selector
de modelos (`GET /api/runtime/models`). La estimación es orientativa: no mide tu GPU ni
la caché KV real.

### Configurar la URL

En `.env`:

```bash
OLLAMA_BASE_URL=http://127.0.0.1:11434
```

En Docker Compose el valor es `http://ollama:11434` y el host `ollama` está permitido
explícitamente. Si usas otro host o puerto:

```bash
ALLOW_CUSTOM_RUNTIME=true
RUNTIME_ALLOWED_HOSTS=ollama,192.168.1.50,gpu-box.local
RUNTIME_ALLOWED_PORTS=11434
```

Para fijar la URL y impedir cambios desde la UI:

```bash
ALLOW_CUSTOM_RUNTIME=false
```

### Autenticación del runtime

Si Ollama está detrás de un proxy con autenticación:

```bash
OLLAMA_AUTH_TOKEN=<token>
```

Se envía como `Authorization: Bearer <token>`. No se devuelve al navegador.

### Ventana de contexto

Forge Local envía `options.num_ctx` en cada petición a `/api/chat`. El valor se configura
con `RUNTIME_NUM_CTX` (en tokens, no en bytes; por defecto `8192`). Sin este parámetro
Ollama usa su propia ventana, que puede ser menor que el contexto permitido por la app y
truncar el prompt sin avisar.

- Un valor mayor permite más archivos e historial, pero consume más memoria de caché KV.
- La estimación de la app es aproximada (`caracteres / 4`); no usa el tokenizador real.
- La UI avisa si el prompt estimado supera `RUNTIME_NUM_CTX` y si `prompt_eval_count`
  queda cerca del límite. También muestra si Ollama corta la salida (`done_reason`).
- Si aparece el aviso, quita archivos, acorta el historial o sube `RUNTIME_NUM_CTX`
  dentro de lo que soporten el modelo y el servidor.

### Runtime remoto

Si el runtime no es loopback y adjuntas archivos, la UI muestra una confirmación con el
host, la ubicación y el resumen de archivos. Hasta que confirmes, la API responde
`409 CONTEXT_AUTHORIZATION_REQUIRED`. Es una protección contra enviar tu código a un
servidor remoto por accidente; no cifra el contenido más allá de HTTPS.

## Hardware y modelos

No hay una regla universal: depende de la cuantización, la longitud de contexto, el
runtime y si usas GPU. No se garantiza que un modelo concreto funcione. Como guía
conservadora para modelos Q4:

| Memoria disponible | Modelo razonable | Expectativa |
| --- | --- | --- |
| 4 GB RAM (sin GPU) | Solo modelos muy pequeños y cuantizados, si caben | Experimental; puede no cargar o ser muy lento |
| 8 GB RAM (sin GPU) | 1-4B Q4, según requisitos actuales | Funciona, pero lento para código |
| 16 GB RAM / GPU 8 GB | Modelos medianos que quepan en VRAM/RAM | Uso interactivo aceptable |
| 24 GB RAM / GPU 12-16 GB | Modelos mayores, si el contexto lo permite | Buena calidad, respuestas más lentas |
| 32 GB+ / GPU 24 GB+ | Modelos grandes | Verifica requisitos; vigila el contexto |

### Perfil de cliente ligero (4 GB de RAM)

El caso recomendado es un portátil con 4 GB de RAM (por ejemplo, i5-6200U, Intel HD 520)
que solo ejecuta la interfaz:

1. Despliega Forge Local + Ollama en un servidor privado con Coolify y
   `DEPLOYMENT_MODE=server`.
2. En el cliente, abre la URL HTTPS y deja `OLLAMA_BASE_URL` apuntando al servidor
   (normalmente el host interno de Ollama o un proxy autenticado).
3. La UI mostrará “Servidor remoto” y enviará solo los archivos que confirmes.
4. Antes de usar un modelo, pulsa **Comprobar recursos** en Ajustes. La app muestra RAM
   y disco del host, modelos cargados y la VRAM que reporta Ollama, pero no puede
   verificar por sí sola toda la máquina remota.
5. En el servidor, revisa `free -h`, `nvidia-smi` (si existe), `ollama ps` y la ficha
   actual del modelo antes de asumir que cabe.

En local, Ollama y el modelo compiten con el navegador y el sistema. No se descarga ni
se inicia nada automáticamente. Si decides probar, cierra otras aplicaciones, usa un
modelo pequeño y vigila el uso de memoria; el límite de contexto por defecto es de
256 KiB y puedes bajarlo aún más en Ajustes.

Notas:

- En Apple Silicon, la memoria unificada se comparte entre CPU y GPU; reserva ~8 GB para
  el sistema.
- La caché KV crece con el contexto. Un modelo con contexto grande puede consumir
  bastante más que sus pesos.
- CPU-only es viable para modelos pequeños, pero la velocidad puede caer a pocos
  tokens/s.
- Reserva disco para el modelo y para el volumen `ollama-models`; vuelve a comprobar el
  espacio libre antes de descargar o guardar.
- Ajusta `OLLAMA_MAX_LOADED_MODELS=1` y `OLLAMA_NUM_PARALLEL=1` si tienes poca memoria.
  Forge Local ya limita a una generación activa por usuario, pero otros clientes pueden
  usar el mismo Ollama.

## Variables que más afectan el comportamiento

| Variable | Efecto |
| --- | --- |
| `MAX_FILE_BYTES` | Tamaño máximo de un archivo de contexto. |
| `MAX_CONTEXT_BYTES` | Suma máxima del contexto; debe ser ≥ `MAX_FILE_BYTES`. |
| `MAX_CONTEXT_FILES` | Número máximo de archivos por consulta. |
| `MAX_STORAGE_BYTES` | Máximo por usuario para conversaciones + copias temporales (64 MiB por defecto). |
| `MAX_MESSAGE_CHARS` | Longitud máxima del mensaje del usuario. |
| `MAX_REQUEST_BYTES` | Cuerpo HTTP máximo. |
| `RUNTIME_TIMEOUT_MS` | Timeout de conexión/no streaming con Ollama. |
| `RUNTIME_STREAM_IDLE_TIMEOUT_MS` | Timeout de inactividad durante el streaming. |
| `RUNTIME_NUM_CTX` | Ventana de contexto en tokens enviada como `options.num_ctx` (8192 por defecto). |
| `PROPOSAL_TTL_MINUTES` | Vida de una propuesta en memoria. |
| `BACKUP_RETENTION_DAYS` | Retención de backups temporales. |
| `CHAT_RATE_LIMIT_PER_MINUTE` | Generaciones por minuto y usuario. |

Los límites por usuario se pueden reducir desde Ajustes, pero nunca superar los del
servidor.

## Tests y calidad

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Los tests de backend usan aplicaciones Fastify reales, SQLite temporal y runtimes
simulados; no necesitan Ollama. Los tests de frontend cubren el wrapper de API, el parser
SSE y utilidades de formato. Para cobertura del backend:

```bash
npm run test:coverage
```

## Solución de problemas

### `Configuración inválida (variables de entorno)`

Zod muestra el nombre del campo. Causas comunes: `PORT` fuera de rango, URL de Ollama
inválida, `MAX_CONTEXT_BYTES < MAX_FILE_BYTES`, o `SESSION_SECRET` demasiado corto.

En producción `SESSION_SECRET` es obligatorio. Genera uno:

```bash
openssl rand -base64 48
```

### `SESSION_SECRET no está definido`

En desarrollo se genera uno efímero; es normal. En producción el arranque falla. Define
el secreto en `.env` o en Coolify.

### Ollama no responde

```bash
curl -v http://127.0.0.1:11434/api/tags
```

Si usas Docker, comprueba que el contenedor `ollama` está healthy y que Forge usa
`http://ollama:11434`. Si usas otro host, revisa `RUNTIME_ALLOWED_HOSTS` y
`RUNTIME_ALLOWED_PORTS`; un host no permitido devuelve `403 RUNTIME_HOST_NOT_ALLOWED`.

### `403 RUNTIME_PORT_NOT_ALLOWED`

El puerto no está en la allowlist. Añádelo a `RUNTIME_ALLOWED_PORTS` o usa 11434.

### `409 CONTEXT_AUTHORIZATION_REQUIRED`

El runtime no es loopback y hay archivos seleccionados. Confirma en el diálogo o usa un
runtime local.

### `404 model not found`

El modelo no está instalado en el Ollama configurado:

```bash
ollama list
ollama pull <modelo>
```

### `413 CONTEXT_TOO_LARGE` o `TOO_MANY_FILES`

Quita archivos, sube `MAX_CONTEXT_BYTES`/`MAX_CONTEXT_FILES` en el servidor y en Ajustes,
o divide la tarea.

### Error de CSRF al enviar

Recarga la página para obtener cookies nuevas. Si estás detrás de un proxy, asegúrate de
que `PUBLIC_ORIGIN` coincide exactamente con el origen del navegador y que
`TRUST_PROXY=true`.

### La sesión se pierde al reiniciar

No definiste `SESSION_SECRET`: se generó uno efímero. Define uno persistente.

### `better-sqlite3` falla al cargar

Reconstruye el módulo nativo para tu versión de Node:

```bash
npm rebuild better-sqlite3
```

### No aparecen proyectos

Deben estar dentro de `PROJECTS_ROOT` y ser carpetas reales (no symlinks). En Docker,
el volumen `forge-projects` empieza vacío; copia los repositorios o usa un bind mount.
