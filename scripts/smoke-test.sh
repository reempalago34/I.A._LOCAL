#!/usr/bin/env bash
# Verificación HTTP mínima de una instancia de Forge Local ya desplegada.
#
# Uso:
#   scripts/smoke-test.sh [URL]
#   FORGE_BASE_URL=https://forge.example.com scripts/smoke-test.sh
#
# Comprueba que /healthz (proceso vivo) y /readyz (SQLite + PROJECTS_ROOT)
# responden 200. No envía credenciales ni imprime cuerpos de respuesta.
set -euo pipefail

BASE_URL="${1:-${FORGE_BASE_URL:-http://127.0.0.1:8080}}"
BASE_URL="${BASE_URL%/}"
TIMEOUT="${FORGE_SMOKE_TIMEOUT:-10}"

fail() {
  printf 'FALLO: %s\n' "$*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail 'curl no está instalado.'

check() {
  local path="$1"
  local body status
  body="$(mktemp)"
  if ! status="$(curl -sS -o "$body" -w '%{http_code}' --max-time "$TIMEOUT" "$BASE_URL$path")"; then
    rm -f "$body"
    fail "no se pudo conectar a $BASE_URL$path"
  fi
  if [ "$status" != '200' ]; then
    printf 'Respuesta de %s:\n' "$path" >&2
    head -c 500 "$body" >&2 || true
    printf '\n' >&2
    rm -f "$body"
    fail "$path devolvió HTTP $status (se esperaba 200)."
  fi
  rm -f "$body"
  printf 'OK %s -> 200\n' "$path"
}

check '/healthz'
check '/readyz'
printf 'Smoke test correcto para %s\n' "$BASE_URL"
