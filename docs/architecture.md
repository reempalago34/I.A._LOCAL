# Arquitectura

## Vista general

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Navegador (SPA React)                                                │
│  Chat · Contexto · Cambios · Backups · Ajustes · Privacidad          │
└───────────────┬──────────────────────────────────────────────────────┘
                │ HTTPS + cookies de sesión + CSRF
┌───────────────▼──────────────────────────────────────────────────────┐
│ Fastify (Node.js 22)                                                 │
│  Auth · Rate limit · Validación Zod · SSE · Estáticos                │
│                                                                      │
│  ┌──────────────┐  ┌────────────────┐  ┌──────────────────────────┐  │
│  │ FileSandbox  │  │ ProposalService│  │ ChatService              │  │
│  │ raíz, límites│  │ diff, backups  │  │ prompt, historial, SSE   │  │
│  └──────┬───────┘  └───────┬────────┘  └────────────┬─────────────┘  │
│         │                  │                        │                │
│         │                  │                ┌───────▼─────────────┐  │
│         │                  │                │ ModelRuntime        │  │
│         │                  │                │ (OllamaRuntime)     │  │
│         │                  │                └───────┬─────────────┘  │
└─────────┼──────────────────┼────────────────────────┼────────────────┘
          │                  │                        │ HTTP/stream
   ┌──────▼──────┐    ┌──────▼───────┐         ┌──────▼──────┐
   │ PROJECTS_ROOT│    │ DATA_DIR     │         │ Ollama      │
   │ repositorios │    │ SQLite + .bak│         │ 11434       │
   └──────────────┘    └──────────────┘         └─────────────┘
```

Forge Local es un monorepo npm con dos workspaces:

- `apps/server`: API, autenticación, acceso a archivos, propuestas, backups y runtime.
- `apps/web`: SPA React compilada por Vite. En producción Fastify sirve `apps/web/dist`
  y hace fallback a `index.html` para rutas del cliente.

No hay router en el frontend: la vista activa es estado local (`chat`, `changes`,
`backups`, `settings`, `privacy`). Tampoco hay telemetría ni servicios externos
obligatorios.

## Componentes del backend

| Módulo | Responsabilidad |
| --- | --- |
| `config.ts` | Esquema Zod de variables de entorno, defaults y reglas de producción. |
| `db.ts` | Esquema SQLite, migración y consultas. WAL y `foreign_keys=ON`. |
| `auth/` | Argon2id, usuarios, sesiones opacas, CSRF, bloqueo de login, cookies. |
| `files/paths.ts` | Normalización, rechazo de rutas absolutas, `..`, NUL y separadores. |
| `files/exclusions.ts` | Exclusiones por defecto y por usuario (picomatch). |
| `files/sandbox.ts` | Resolución segura, rechazo de symlinks, lectura, escritura atómica, hash. |
| `files/context.ts` | Límites, preview exacto del contexto y formateo para el prompt. |
| `projects/routes.ts` | Selección de carpetas dentro de `PROJECTS_ROOT` y árbol de archivos. |
| `proposals/` | Parseo, diff unificado, store en memoria, backups, apply/reject/restore. |
| `chat/` | Preparación de mensajes, límites, streaming SSE, historial y finalización. |
| `runtime/` | Política de URL, estimación de hardware, alcance de ejecución y adaptador Ollama. |
| `system/` | Comprobación de recursos del host y del runtime (`/api/system/resources`). |
| `storage/` | Uso de conversaciones, backups, temporales, caché y disco; límites por usuario. |
| `commands/` | Análisis y ejecución opcional con allowlist, sin shell, timeout y límites. |
| `settings/` | Preferencias por usuario, límites y controles de privacidad. |
| `utils/errors.ts` | Errores públicos sin filtrar trazas ni secretos. |

## Almacenamiento

```text
DATA_DIR/
├── forge.sqlite         # usuarios, sesiones, ajustes, proyectos, conversaciones, backups
├── forge.sqlite-wal     # WAL de SQLite
├── backups/             # contenido de backups temporales (solo si se aplicó una propuesta)
└── tmp/home-<userId>/   # HOME/TMP aislado para comandos opcionales
```

- **Archivos del proyecto**: nunca se copian a la base de datos. Se leen desde
  `PROJECTS_ROOT` en el momento de la petición y solo si el usuario los selecciona.
- **Propuestas**: viven en memoria con TTL (`PROPOSAL_TTL_MINUTES`). Un reinicio las
  descarta; el archivo no se modifica hasta que se acepta.
- **Backups**: se guardan como archivos `0600` en `DATA_DIR/backups` y metadatos en
  SQLite. Caducan según `BACKUP_RETENTION_DAYS` y la limpieza periódica.
- **Historial**: las conversaciones solo se escriben si el usuario activa
  `persistHistory`. El historial enviado al modelo se limita en cantidad y caracteres.
- **Secretos**: `SESSION_SECRET` y `OLLAMA_AUTH_TOKEN` vienen del entorno; no se escriben
  en SQLite ni se devuelven al cliente.

### Tablas SQLite

| Tabla | Contenido |
| --- | --- |
| `users` | Correo, nombre, hash Argon2id, rol. |
| `sessions` | Hash SHA-256 del token, CSRF, expiración, último uso, hash de IP. |
| `settings` | JSON por usuario (runtime, modelo, idioma, tema, límites, exclusiones). |
| `projects` | ID, propietario, nombre y ruta relativa dentro de `PROJECTS_ROOT`. |
| `conversations` / `messages` | Historial opcional; el contenido solo existe si se activó. |
| `login_attempts` | Claves HMAC de IP/correo para el bloqueo temporal. |
| `backups` | Metadatos de backups; el contenido está en `DATA_DIR/backups`. |

## Flujo de una consulta

1. El navegador envía `POST /api/chat` con mensaje, modelo, proyecto y rutas de contexto.
2. Fastify valida sesión y CSRF, aplica rate limit y límite de concurrencia por usuario.
3. `ChatService.prepare` resuelve el runtime, comprueba el modelo y construye el contexto
   leyendo solo los archivos elegidos.
4. Si el runtime no es loopback y hay archivos, el backend responde
   `409 CONTEXT_AUTHORIZATION_REQUIRED` con el host, la ubicación y el resumen. El
   cliente debe reenviar con `confirmRemoteContext: true`.
5. La respuesta se transmite por SSE: `meta`, `delta`, `proposals`, `commands`,
   `warnings`, `done`, `error`.
6. Al terminar, el parser separa propuestas y comandos del Markdown visible. Las
   propuestas se validan, se convierten en diff y se guardan en memoria.

## Flujo de una propuesta

```text
Modelo ──<proposal path="src/a.ts" action="write">──► parser
                                                       │
                                  normalización de ruta, exclusiones, tamaño
                                                       │
                                                   diff unificado
                                                       │
                                            ProposalStore (memoria, TTL)
                                                       │
                                     UI muestra diff ──┴──► aceptar / rechazar
                                                       │
                               ¿hash actual == hash original? ── no ──► 409
                                                       │ sí
                                     backup temporal + escritura atómica
                                                       │
                                       hash posterior registrado en el backup
```

- Rutas relativas, sin `..`, sin absolutas y sin symlinks.
- Se rechazan archivos fuera de `PROJECTS_ROOT`, archivos binarios, no UTF-8 y mayores
  que el límite configurado.
- Un cambio concurrente invalida la propuesta (`FILE_CHANGED`).
- Restaurar un backup también detecta conflictos; `force: true` solo tras confirmación
  explícita en la UI.

## Flujo de comandos

Los bloques `<command>` se muestran como tarjetas. El backend analiza el texto y
rechaza operadores de shell (`; & | > < $ \``), saltos de línea, asignaciones de entorno,
rutas absolutas, `..` y opciones peligrosas de git. La ejecución:

- está desactivada salvo `ENABLE_COMMAND_EXECUTION=true`;
- exige `confirmation: "EJECUTAR"`;
- usa `spawn` con `shell: false` y un `PATH`/`HOME`/`TMPDIR` mínimos;
- aplica timeout, límite de salida y allowlist de comandos completos (con denegaciones
  adicionales para `node -e`, `npx`, instalaciones de npm y git con hooks/programas
  externos);
- mata el grupo de procesos al terminar o agotar el tiempo.

No hay aislamiento de contenedor desde la aplicación. Si habilitas comandos, el proceso
corre con el usuario de Forge Local y puede modificar el proyecto.

## API

Todas las rutas `/api/*` requieren sesión salvo `auth/config`, `auth/csrf`,
`auth/login`, `auth/register` y el propio flujo de cookies. Los métodos `POST`, `PUT`,
`PATCH` y `DELETE` requieren CSRF y `Origin` válido.

| Método | Ruta | Función |
| --- | --- | --- |
| `GET` | `/healthz`, `/readyz` | Liveness y readiness (SQLite + raíz de proyectos). |
| `GET` | `/api/auth/config` | Registro, modo de despliegue, comandos, telemetría. |
| `GET` | `/api/auth/csrf` | Token CSRF y cookie. |
| `GET` | `/api/auth/me` | Usuario actual y CSRF. |
| `POST` | `/api/auth/login` | Login con bloqueo y delay. |
| `POST` | `/api/auth/register` | Registro solo si está habilitado. |
| `POST` | `/api/auth/logout` | Cierra la sesión. |
| `POST` | `/api/auth/password` | Cambio de contraseña; invalida otras sesiones. |
| `GET/PATCH/DELETE` | `/api/settings` | Leer, actualizar o restablecer ajustes. |
| `GET` | `/api/privacy` | Resumen de datos almacenados. |
| `DELETE` | `/api/privacy/data` | Borra historial/backups (`confirmation: "BORRAR"`). |
| `GET` | `/api/storage` | Uso de conversaciones, backups, temporales, caché y disco. |
| `DELETE` | `/api/storage/temp` | Borra temporales y propuestas en memoria (`confirmation: "BORRAR"`). |
| `GET` | `/api/system/resources` | RAM/CPU/disco, runtime, modelos cargados, GPU y comprobaciones. |
| `GET` | `/api/workspace` | Navega `PROJECTS_ROOT` con exclusiones. |
| `GET/POST` | `/api/projects` | Lista o registra un proyecto. |
| `GET` | `/api/projects/:id/tree` | Árbol con límites y exclusiones. |
| `DELETE` | `/api/projects/:id` | Elimina el registro y sus backups. |
| `POST` | `/api/context/preview` | Contenido exacto y estimación de tokens. |
| `GET` | `/api/proposals` | Propuestas pendientes en memoria. |
| `POST` | `/api/proposals/:id/apply` | Aplica con backup y detección de conflictos. |
| `POST` | `/api/proposals/:id/reject` | Rechaza. |
| `GET` | `/api/backups` | Lista backups. |
| `POST` | `/api/backups/:id/restore` | Restaura (`confirmation: "RESTAURAR"`). |
| `DELETE` | `/api/backups/:id` | Borra un backup. |
| `GET/POST` | `/api/conversations` | Lista o crea conversaciones. |
| `GET/PATCH/DELETE` | `/api/conversations/:id` | Leer, renombrar o borrar. |
| `POST` | `/api/commands/analyze` | Analiza sin ejecutar. |
| `POST` | `/api/commands/execute` | Ejecuta con confirmación explícita. |
| `POST` | `/api/chat` | Streaming SSE de la respuesta. |
| `GET` | `/api/runtime/status` | Salud de Ollama. |
| `GET` | `/api/runtime/models` | Modelos instalados y requisitos estimados. |
| `GET` | `/api/runtime/model?name=` | Detalle de un modelo. |

Los errores tienen la forma `{ error: { code, message, details?, requestId } }`. Los
errores de validación devuelven `400`; los conflictos de archivo, `409`; los límites,
`413`/`429`.

## Decisiones de diseño

- **Sin indexado**: el contexto se construye por petición. Evita exponer archivos no
  elegidos y mantiene el comportamiento predecible.
- **Propuestas, no escrituras del modelo**: el modelo nunca tiene acceso directo al
  sistema de archivos. Toda escritura pasa por revisión y backup.
- **Runtime desacoplado**: `ModelRuntime` expone `health`, `listModels`, `getModel` y
  `chat`; añadir otro backend compatible no requiere tocar la UI.
- **SSE sobre WebSocket**: una sola dirección, compatible con proxies, cancelable por
  cierre de conexión y sin estado adicional.
- **SQLite**: suficiente para un equipo pequeño, sin servicio extra y con backups
  triviales. El límite es un escritor concurrente y no está pensado para alta escala.
