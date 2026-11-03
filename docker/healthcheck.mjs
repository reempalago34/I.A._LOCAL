#!/usr/bin/env node
/**
 * Healthcheck del contenedor. Usa /readyz, que comprueba SQLite y que la raíz
 * de proyectos sea accesible. No imprime secretos ni rutas del host.
 */
const port = Number(process.env.PORT || 8080);
const url = `http://127.0.0.1:${port}/readyz`;

try {
  const response = await fetch(url, { signal: AbortSignal.timeout(4_000) });
  if (!response.ok) {
    console.error(`[healthcheck] /readyz respondió ${response.status}`);
    process.exit(1);
  }
  const body = await response.json();
  if (body?.status !== 'ready') {
    console.error('[healthcheck] el servicio no está listo');
    process.exit(1);
  }
  process.exit(0);
} catch (error) {
  console.error(
    '[healthcheck] no se pudo comprobar el servicio:',
    error instanceof Error ? error.message : 'error desconocido',
  );
  process.exit(1);
}
