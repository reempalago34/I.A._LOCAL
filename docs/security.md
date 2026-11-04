# Seguridad

Este documento describe el modelo de amenazas, los controles implementados y los
riesgos que quedan fuera del alcance de la aplicación. Forge Local está pensado para
un equipo pequeño y de confianza que autoaloja su propio asistente; no es un servicio
multitenante para usuarios hostiles.

## Modelo de amenazas

Activos a proteger:

- Archivos de los proyectos bajo `PROJECTS_ROOT`.
- Historial de conversaciones y backups temporales.
- Credenciales de sesión y `SESSION_SECRET`.
- El propio servidor donde corre el contenedor.
- La privacidad del código enviado al modelo.

Amenazas principales:

| Amenaza | Control principal |
| --- | --- |
| Acceso no autenticado | Sesiones opacas + rate limiting |
| Fuerza bruta de contraseñas | Argon2id, bloqueo por IP/correo, delay progresivo |
| CSRF | Double-submit + token ligado a sesión + validación de `Origin` |
| XSS / clickjacking | React sin HTML crudo, CSP estricta, `frame-ancestors 'none'` |
| Path traversal / symlinks | Normalización, confinamiento y rechazo de enlaces |
| Exfiltración por el modelo | Contexto explícito, preview y confirmación remota |
| Escrituras no revisadas | Propuestas + diff + backup + hash de conflicto |
| Comandos destructivos | Desactivados por defecto, allowlist, sin shell, timeout |
| Fugas en logs | Redacción de cookies/CSRF y ausencia de cuerpos en logs |
| Robo de volúmenes | Contenedores sin root, FS de solo lectura, volúmenes dedicados |

## Autenticación

- Contraseñas con **Argon2id** (`memoryCost=19456 KiB`, `timeCost=2`,
  `parallelism=1`, salida de 32 bytes).
- Longitud mínima de 12 caracteres, bloqueo de contraseñas comunes, de contraseñas que
  contienen el correo y de patrones demasiado repetitivos.
- Comparación de contraseña con hash ficticio cuando el correo no existe, para reducir
  diferencias de tiempo.
- Intentos fallidos registrados con claves HMAC (`HMAC-SHA256` con `SESSION_SECRET`),
  no con IP/correo en claro.
- Tras `LOGIN_MAX_ATTEMPTS` dentro de `LOGIN_WINDOW_MINUTES` se devuelve `429`; los
  fallos añaden un delay progresivo de hasta 2 s.
- El login tiene además un límite de ruta de 10 peticiones/minuto por IP.
- El registro público está desactivado por defecto. Las cuentas se crean con la CLI.
- El cambio de contraseña invalida las demás sesiones y obliga a iniciar sesión de nuevo.

## Sesiones y cookies

- Token de sesión aleatorio de 32 bytes; solo se guarda su hash SHA-256 en SQLite.
- Cookie de sesión `forge_sid` con `HttpOnly`, `SameSite=Lax`, `Path=/` y `Secure`
  automático en HTTPS.
- Cookie CSRF `forge_csrf` legible por JavaScript (necesario para el double-submit),
  también `SameSite=Lax` y `Secure` en HTTPS.
- Expiración absoluta (`SESSION_TTL_HOURS`, 168 h por defecto) e inactividad
  (`SESSION_IDLE_HOURS`, 48 h por defecto).
- `PUBLIC_ORIGIN` fija el origen esperado; si no está definido, se compara con el
  `Host` de la petición.
- Las sesiones se eliminan de SQLite al cerrar sesión, caducar o cambiar contraseña.

## CSRF y validación de origen

Todos los `POST`, `PUT`, `PATCH` y `DELETE` bajo `/api/` exigen:

1. Cookie `forge_csrf` y cabecera `X-CSRF-Token` con el mismo valor.
2. Si hay sesión, que el token coincida con el token CSRF de esa sesión.
3. Si la petición trae `Origin`, que coincida con `PUBLIC_ORIGIN` o con el origen del
   host actual.

La comparación de tokens usa tiempo constante. Una petición sin `Origin` puede pasar la
comprobación de origen, pero sigue necesitando el token CSRF; los navegadores modernos
envían `Origin` en peticiones mutantes.

## Rate limiting y abuso

| Ámbito | Límite por defecto |
| --- | --- |
| Global por IP | `API_RATE_LIMIT_PER_MINUTE` = 120/min |
| Login | 10/min por IP + bloqueo de credenciales |
| Registro | 5/10 min por IP |
| Chat | `CHAT_RATE_LIMIT_PER_MINUTE` = 20/min por usuario |
| Concurrencia de chat | Una generación activa por usuario |
| Comandos | Sujetos a los límites globales y a confirmación explícita |

`TRUST_PROXY=true` es necesario detrás de Coolify/Traefik para que la IP real y HTTPS se
detecten. Actívalo **solo** si hay un proxy de confianza delante; si no, un cliente
podría falsificar `X-Forwarded-For`.

## Cabeceras y frontend

- CSP: `default-src 'self'`, `script-src 'self'`, `style-src 'self'`, `connect-src
  'self'`, `object-src 'none'`, `frame-ancestors 'none'`.
- `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer`.
- HSTS en producción o cuando `PUBLIC_ORIGIN` es HTTPS.
- `Cache-Control: no-store` en todas las respuestas `/api/`.
- React Markdown no habilita HTML crudo; los enlaces externos usan
  `rel="noreferrer noopener"`.
- No se usa `localStorage` para tokens de sesión.

## Archivos y sistema de archivos

- Todas las rutas son relativas a `PROJECTS_ROOT`; se rechazan rutas absolutas, `..`,
  separadores alternativos, NUL y entradas vacías.
- Se resuelve la ruta real y se comprueba que siga dentro de la raíz.
- Se rechazan symlinks en cualquier componente de la ruta, incluida la raíz del
  proyecto.
- Solo se leen archivos de texto UTF-8 dentro del límite por archivo y del límite total
  de contexto.
- Exclusiones por defecto, sin distinguir mayúsculas: `.env*`, extensiones de claves y
  certificados, credenciales/secretos con nombres concretos, binarios, imágenes, vídeos,
  archivos comprimidos, bases de datos y logs. `.git`, `node_modules`, cachés y entornos
  virtuales se bloquean a cualquier profundidad; `dist`, `build`, `out`, `target`,
  `coverage`, `.next` y `.nuxt` solo en la raíz, para no ocultar código como
  `src/build/index.ts`. Se pueden añadir patrones por usuario.
- La escritura usa archivo temporal + `rename` atómico y verifica el hash esperado.
- El backup se crea **antes** de escribir y se guarda con permisos `0600`.

### Escritura atómica y conflictos

Antes de aplicar una propuesta se compara el hash actual del archivo con el hash
capturado al generarla. Si cambió, se devuelve `409 FILE_CHANGED` y no se escribe. Si se
acepta, se crea el backup, se escribe de forma atómica y se registra el hash posterior.
Al restaurar, también se detecta si el archivo cambió después; se requiere `force` tras
confirmación explícita.

## Privacidad y logs

- **Telemetría desactivada**. No hay analítica, crash reporting ni llamadas a terceros.
- El historial persistente está desactivado por defecto. Si se activa, se guardan
  mensajes en SQLite; los archivos de contexto no.
- No se registran prompts, respuestas, contenido de archivos, tokens ni contraseñas.
- Fastify redacta `authorization`, `cookie`, `x-csrf-token` y `set-cookie`.
- Los errores públicos no incluyen trazas, rutas internas ni detalles del runtime.
- La página de Privacidad permite borrar historial, backups o ambos con confirmación
  escrita (`BORRAR`).

## Runtime remoto

- La URL se valida (HTTP/HTTPS, sin credenciales, sin query/hash) y se limita por host y
  puerto.
- `ALLOW_CUSTOM_RUNTIME=false` fija la URL del administrador.
- Se bloquean direcciones de metadata (`169.254.169.254`, `100.100.100.200`, `::`,
  `0.0.0.0`, `metadata.google.internal`).
- Se clasifica el runtime como `local`, `private` o `remote`.
- Si hay archivos de contexto y el runtime no es loopback, la API responde
  `409 CONTEXT_AUTHORIZATION_REQUIRED`; el usuario debe confirmar explícitamente que
  acepta enviar esos archivos fuera de la máquina.
- `OLLAMA_AUTH_TOKEN` se envía como `Authorization: Bearer` y nunca se devuelve al
  cliente.

La confirmación remota es una decisión del usuario, no una garantía criptográfica: si
el runtime remoto es malicioso o está comprometido, puede quedarse con el contexto.

## Ejecución local y recursos

- La app no descarga ni inicia modelos. La ejecución local es experimental y requiere
  comprobar RAM, disco y requisitos actuales del modelo.
- Con `DEPLOYMENT_MODE=server` la interfaz indica “Servidor remoto”; en despliegue local
  con un runtime loopback indica “Este computador”.
- `/api/system/resources` expone RAM/CPU/disco del host de la app, modelos cargados y la
  VRAM reportada por Ollama. No inspecciona la máquina anfitriona remota ni garantiza
  que un modelo concreto funcione.
- El contexto se procesa por fragmentos y se libera al terminar cada generación; los
  límites por archivo, total y número de archivos están activos por defecto.
- `MAX_STORAGE_BYTES` limita datos persistidos por usuario y `DELETE /api/storage/temp`
  borra temporales y propuestas en memoria con confirmación.

## Comandos

- Desactivados por defecto (`ENABLE_COMMAND_EXECUTION=false`).
- Aunque estén habilitados, el modelo solo **propone**; la ejecución requiere
  `confirmation: "EJECUTAR"` desde la UI.
- Se rechazan operadores de shell, redirecciones, variables, sustitución, saltos de
  línea, asignaciones de entorno, rutas absolutas, `..` y opciones peligrosas de git.
- `COMMAND_ALLOWLIST` contiene comandos completos o prefijos de tokens, no binarios
  sueltos: `git status` permite `git status --short`, pero `node` se ignora. El valor por
  defecto solo incluye lecturas de git y `node --version`/`npm --version`.
- Se deniegan siempre `npx`, `node -e`/`--eval`/`-p`/`--print`, instalaciones de npm
  (`install`, `ci`, `add`, `update`, etc.), `npm exec`, las opciones de git que cambian
  configuración/rutas/transporte (`-c`, `--config-env`, `--exec-path`, `--upload-pack`,
  `--receive-pack`, `--git-dir`, `--work-tree`, `-C`) y los subcomandos de git que pueden
  ejecutar hooks, alias o programas externos (solo se permiten subcomandos de lectura).
- `spawn` con `shell: false`, timeout, límite de salida, entorno mínimo y `HOME`/`TMPDIR`
  dentro de `DATA_DIR`.
- Se mata el grupo de procesos al agotar el timeout.
- La UI avisa antes de ejecutar scripts (`npm test`, `npm run ...`) si en esta sesión se
  aplicó una propuesta sobre `package.json`, `scripts/` o configuración de CI.

**No hay aislamiento de contenedor desde la aplicación.** Un comando permitido puede
leer y modificar el proyecto y consumir CPU/RAM. Si habilitas esta función, hazlo en un
host dedicado o añade aislamiento externo (contenedor por ejecución, seccomp, usuario
sin acceso a red, etc.).

## Endurecimiento del despliegue

El `docker-compose.yml` incluido:

- ejecuta Forge Local como usuario `node` (UID 1000), sin root;
- usa `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges` y `tmpfs` para `/tmp`;
- publica el puerto de la app solo en `127.0.0.1`;
- no publica el puerto de Ollama y lo deja en una red dedicada;
- declara volúmenes persistentes, healthchecks, `stop_grace_period`, `pids_limit` y
  límites de memoria/CPU;
- no monta el socket de Docker ni usa `privileged`.

Recomendaciones adicionales:

1. Usa HTTPS con un proxy de confianza y `PUBLIC_ORIGIN` exacto.
2. Define `SESSION_SECRET` aleatorio (mínimo 32 caracteres) y guárdalo como secreto.
3. Mantén `ALLOW_REGISTRATION=false` y `ENABLE_COMMAND_EXECUTION=false` salvo necesidad.
4. Restringe el firewall al puerto del proxy; no expongas 8080 ni 11434.
5. Separa `PROJECTS_ROOT` de datos personales y usa permisos mínimos.
6. Rota `SESSION_SECRET` si sospechas compromiso; invalida todas las sesiones.
7. Actualiza la imagen de Ollama y los modelos de forma controlada.
8. Haz copias de `DATA_DIR` y de `PROJECTS_ROOT` antes de actualizar.

## Riesgos residuales

- **Sin aislamiento por usuario**: cualquier cuenta autenticada puede navegar y registrar
  cualquier carpeta bajo `PROJECTS_ROOT`. Los proyectos son privados en la base de datos,
  pero el sistema de archivos es compartido. Para equipos hostiles, usa una instancia por
  equipo o un contenedor por usuario con su propio `PROJECTS_ROOT`.
- **Inyección de prompt**: los archivos se marcan como datos no confiables y el modelo
  recibe instrucciones para no obedecerlos, pero un LLM puede ser manipulado. La última
  barrera es la revisión humana del diff y de los comandos.
- **Modelo malicioso**: un runtime comprometido puede exfiltrar el contexto autorizado.
  Usa modelos y servidores de confianza.
- **SSRF por DNS**: la allowlist valida el hostname, no la IP resuelta. Un hostname
  permitido que resuelva a una IP interna podría alcanzarla. Configura
  `RUNTIME_ALLOWED_HOSTS` de forma estricta y evita `*`.
- **Sin aislamiento de comandos**: ver arriba.
- **Sin antivirus ni análisis de secretos**: las exclusiones reducen el riesgo, pero no
  detectan secretos dentro de archivos de código seleccionados manualmente. El preview
  muestra exactamente lo que se enviará.
- **SQLite**: un solo escritor. Adecuado para equipos pequeños; no para alta concurrencia.
- **Imagen Docker no verificada en este entorno**: no había Docker disponible durante el
  desarrollo. Los tests validan propiedades estáticas del Dockerfile y del compose, pero
  debes construir y desplegar en un entorno de prueba.

## Checklist antes de exponer a Internet

- [ ] `SESSION_SECRET` aleatorio y guardado fuera del repo.
- [ ] `PUBLIC_ORIGIN` con el dominio HTTPS exacto.
- [ ] `TRUST_PROXY=true` solo detrás del proxy.
- [ ] `ALLOW_REGISTRATION=false`.
- [ ] `ENABLE_COMMAND_EXECUTION=false` o aislamiento externo.
- [ ] Puerto 8080 solo en loopback; 11434 nunca publicado.
- [ ] Volúmenes persistentes y backups probados.
- [ ] `PROJECTS_ROOT` con permisos mínimos y sin datos personales.
- [ ] Healthchecks y logs revisados.
- [ ] Prueba de restauración de un backup.
