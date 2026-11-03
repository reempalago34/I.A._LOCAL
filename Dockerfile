# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------
# Dependencias + compilación
# ---------------------------------------------------------------------------
FROM node:22.23.4-bookworm-slim AS build

WORKDIR /app
ENV npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false

# better-sqlite3 necesita compilar si no hay binario precompilado para la
# plataforma. Estas herramientas no se copian a la imagen final.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --no-audit --no-fund

COPY tsconfig.base.json biome.json ./
COPY apps ./apps

RUN npm run build \
 && npm prune --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------------------
# Imagen de ejecución: sin toolchain, sin root, solo artefactos necesarios
# ---------------------------------------------------------------------------
FROM node:22.23.4-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="Forge Local" \
      org.opencontainers.image.description="Asistente de código autoalojado para modelos locales" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data \
    PROJECTS_ROOT=/projects \
    WEB_DIST=/app/apps/web/dist

WORKDIR /app

# La imagen oficial ya incluye el usuario sin privilegios "node" (UID 1000).
RUN mkdir -p /data /projects \
 && chown -R node:node /data /projects /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --chown=node:node docker/healthcheck.mjs ./docker/healthcheck.mjs

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD ["node", "docker/healthcheck.mjs"]

STOPSIGNAL SIGTERM

CMD ["node", "apps/server/dist/index.js"]
