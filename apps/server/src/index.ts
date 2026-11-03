import { buildApp } from './app.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.generatedSessionSecret) {
    console.warn(
      '[forge] SESSION_SECRET no está definido. Se generó uno efímero; las sesiones se invalidarán al reiniciar. Configúralo en .env o en Coolify.',
    );
  }
  if (config.isProduction && !config.publicOrigin) {
    console.warn(
      '[forge] PUBLIC_ORIGIN no está definido. Configúralo con tu URL HTTPS para validar el origen de las solicitudes.',
    );
  }
  if (config.isProduction && !config.trustProxy) {
    console.warn(
      '[forge] TRUST_PROXY está desactivado. Detrás de Coolify/Traefik normalmente debe ser true para que la IP y HTTPS se detecten correctamente.',
    );
  }

  const { app } = await buildApp({ config });
  let closing = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'Cerrando Forge Local');
    const timeout = setTimeout(() => {
      app.log.error('El cierre ordenado tardó demasiado; se fuerza la salida.');
      process.exit(1);
    }, 12_000);
    timeout.unref();
    try {
      await app.close();
      clearTimeout(timeout);
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'Error durante el cierre');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'Promesa rechazada no controlada');
  });
  process.on('uncaughtException', (error) => {
    app.log.error({ err: error }, 'Excepción no controlada');
    void shutdown('uncaughtException');
  });

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      host: config.host,
      port: config.port,
      deploymentMode: config.deploymentMode,
      projectsRoot: config.projectsRoot,
      dataDir: config.dataDir,
    },
    'Forge Local escuchando',
  );
}

main().catch((error) => {
  console.error(
    '[forge] No se pudo iniciar la aplicación:',
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
