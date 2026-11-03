import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuthHooks } from './auth/hooks.js';
import { registerAuthRoutes } from './auth/routes.js';
import { AuthService } from './auth/service.js';
import { registerConversationRoutes } from './chat/conversations.js';
import { registerChatRoutes } from './chat/routes.js';
import { ChatService } from './chat/service.js';
import { registerCommandRoutes } from './commands/routes.js';
import { CommandService } from './commands/service.js';
import { type AppConfig, loadConfig } from './config.js';
import { openDatabase, Store } from './db.js';
import { registerFileRoutes } from './files/routes.js';
import { FileSandbox } from './files/sandbox.js';
import { registerProjectRoutes } from './projects/routes.js';
import { BackupService } from './proposals/backups.js';
import { registerProposalRoutes } from './proposals/routes.js';
import { ProposalService } from './proposals/service.js';
import { ProposalStore } from './proposals/store.js';
import type { ModelRuntime } from './runtime/types.js';
import { registerSettingsRoutes } from './settings/routes.js';
import { SettingsService } from './settings/service.js';
import { StorageService } from './storage/service.js';
import { registerSystemRoutes } from './system/routes.js';
import { errorHandler } from './utils/errors.js';

export interface BuildAppOptions {
  config?: AppConfig;
  serveStatic?: boolean;
  runtimeFactory?: (target: import('./runtime/url-policy.js').RuntimeTarget) => ModelRuntime;
}

export interface BuiltApp {
  app: FastifyInstance;
  config: AppConfig;
  store: Store;
  chat: ChatService;
  backups: BackupService;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<BuiltApp> {
  const config = options.config ?? loadConfig();
  prepareDirectories(config);

  const db = openDatabase(config.databasePath);
  const store = new Store(db);
  const auth = new AuthService(store, config);
  const settings = new SettingsService(store, config);
  const sandbox = new FileSandbox(config.projectsRoot);
  await sandbox.ensureRoot();
  const proposalStore = new ProposalStore(config.proposalTtlMs);
  const backups = new BackupService(store, config);
  await backups.ensure();
  const storage = new StorageService(store, settings, backups, config);
  const proposals = new ProposalService(
    store,
    sandbox,
    settings,
    proposalStore,
    backups,
    storage,
    config,
  );
  const chat = new ChatService(store, config, settings, sandbox, storage, options.runtimeFactory);
  const commands = new CommandService(config, store, sandbox);

  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-csrf-token"]',
          'res.headers["set-cookie"]',
        ],
        censor: '[redacted]',
      },
      base: { service: 'forge-local' },
    },
    trustProxy: config.trustProxy,
    bodyLimit: config.maxRequestBytes,
    requestTimeout: 30_000,
    connectionTimeout: 30_000,
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(config.isProduction || config.publicOrigin?.startsWith('https://')
          ? { upgradeInsecureRequests: [] }
          : {}),
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts:
      config.isProduction || config.publicOrigin?.startsWith('https://')
        ? { maxAge: 31_536_000, includeSubDomains: true }
        : false,
  });
  await app.register(rateLimit, {
    global: true,
    max: config.apiRateLimitPerMinute,
    timeWindow: '1 minute',
    allowList: (request) => request.url === '/healthz' || request.url === '/readyz',
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: (request) => ({
      statusCode: 429,
      error: 'RATE_LIMITED',
      message: 'Demasiadas solicitudes. Espera un momento.',
      requestId: request.id,
    }),
  });

  app.setErrorHandler(errorHandler);

  registerAuthHooks(app, { store, config, auth });
  registerAuthRoutes(app, { config, auth });
  registerSettingsRoutes(app, { store, config, settings, backups });
  registerSystemRoutes(app, { config, settings, storage, proposals });
  registerProjectRoutes(app, { store, sandbox, settings, backups });
  registerFileRoutes(app, { store, sandbox, settings });
  registerProposalRoutes(app, { proposals, backups });
  registerConversationRoutes(app, { store });
  registerCommandRoutes(app, { commands });
  registerChatRoutes(app, { config, chat, proposals, settings });

  registerHealthRoutes(app, store, sandbox);

  if (options.serveStatic !== false && existsSync(config.webDist)) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      prefix: '/',
      wildcard: true,
      index: ['index.html'],
      cacheControl: true,
      maxAge: '1h',
      immutable: false,
      setHeaders: (response, filePath) => {
        if (filePath.endsWith('index.html')) {
          (response as unknown as { setHeader(name: string, value: string): void }).setHeader(
            'Cache-Control',
            'no-cache',
          );
        }
      },
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        reply.code(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Endpoint no encontrado.',
            requestId: request.id,
          },
        });
        return;
      }
      if (request.method === 'GET' || request.method === 'HEAD') {
        reply.type('text/html').sendFile('index.html');
        return;
      }
      reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No encontrado.' } });
    });
  } else {
    app.setNotFoundHandler((request, reply) => {
      reply.code(404).send({
        error: {
          code: 'NOT_FOUND',
          message: request.url.startsWith('/api/')
            ? 'Endpoint no encontrado.'
            : 'La interfaz no está compilada en este entorno de desarrollo.',
          requestId: request.id,
        },
      });
    });
  }

  const intervals: NodeJS.Timeout[] = [];
  const cleanup = () => {
    const now = Date.now();
    try {
      store.deleteExpiredSessions(now);
      store.cleanupLoginAttempts(now - Math.max(config.loginWindowMs * 2, 3_600_000));
      proposalStore.cleanup();
      void backups.cleanupExpired();
    } catch (error) {
      app.log.error({ err: error }, 'Error en limpieza periódica');
    }
  };
  const interval = setInterval(cleanup, 10 * 60_000);
  interval.unref();
  intervals.push(interval);

  app.addHook('onClose', async () => {
    for (const timer of intervals) clearInterval(timer);
    chat.shutdown();
    store.close();
  });

  app.decorate('forge', { config, store, chat });
  return { app, config, store, chat, backups };
}

function prepareDirectories(config: AppConfig): void {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(config.dataDir, 0o700);
  } catch {
    // Algunos volúmenes administrados no permiten chmod; se documenta el requisito.
  }
  mkdirSync(config.projectsRoot, { recursive: true, mode: 0o700 });
  try {
    chmodSync(config.projectsRoot, 0o700);
  } catch {
    // Ver nota anterior.
  }
  mkdirSync(`${config.dataDir}/tmp`, { recursive: true, mode: 0o700 });
}

function registerHealthRoutes(app: FastifyInstance, store: Store, sandbox: FileSandbox): void {
  app.get('/healthz', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { status: 'ok' };
  });

  app.get('/readyz', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      store.ping();
      await sandbox.ensureRoot();
      return { status: 'ready' };
    } catch {
      reply.code(503);
      return { status: 'unavailable' };
    }
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    forge: {
      config: AppConfig;
      store: Store;
      chat: ChatService;
    };
  }
}
