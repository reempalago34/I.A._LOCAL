import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/hooks.js';
import type { AppConfig } from '../config.js';
import type { Store } from '../db.js';
import type { BackupService } from '../proposals/backups.js';
import type { SettingsService } from './service.js';

const patchSchema = z.record(z.string(), z.unknown());

export function registerSettingsRoutes(
  app: FastifyInstance,
  options: {
    store: Store;
    config: AppConfig;
    settings: SettingsService;
    backups: BackupService;
  },
): void {
  const { config, settings, store, backups } = options;

  app.get('/api/settings', async (request) => {
    const { user } = requireAuth(request);
    const userSettings = settings.get(user.id);
    return {
      settings: userSettings,
      server: {
        deploymentMode: config.deploymentMode,
        allowCustomRuntime: config.allowCustomRuntime,
        defaultRuntimeUrl: config.defaultRuntimeUrl,
        registrationEnabled: config.allowRegistration,
        commandExecutionEnabled: config.enableCommandExecution,
        runtimeNumCtx: config.runtimeNumCtx,
        telemetryEnabled: false,
        limits: {
          maxFileBytes: config.maxFileBytes,
          maxContextBytes: config.maxContextBytes,
          maxContextFiles: config.maxContextFiles,
          maxMessageChars: config.maxMessageChars,
          maxStorageBytes: config.maxStorageBytes,
        },
      },
      storage: {
        conversationsPersisted: userSettings.persistHistory,
        backupsRetentionDays: config.backupRetentionDays,
        telemetry: 'disabled',
        note: 'Los archivos del proyecto no se guardan en la base de datos. Solo se leen al enviar una consulta y, si aceptas una propuesta, se crea un backup temporal para poder deshacer.',
      },
    };
  });

  app.patch('/api/settings', async (request) => {
    const { user } = requireAuth(request);
    const body = patchSchema.parse(request.body ?? {});
    return { settings: settings.update(user.id, body) };
  });

  app.delete('/api/settings', async (request) => {
    const { user } = requireAuth(request);
    return { settings: settings.reset(user.id) };
  });

  app.get('/api/privacy', async (request) => {
    const { user } = requireAuth(request);
    const conversations = store.listConversations(user.id);
    return {
      conversations: conversations.length,
      messages: conversations.reduce(
        (sum, conversation) => sum + store.countMessages(conversation.id),
        0,
      ),
      backups: store.listBackups(user.id).length,
      backupRetentionDays: config.backupRetentionDays,
      historyEnabled: settings.get(user.id).persistHistory,
      telemetry: false,
      note: 'No se registran prompts, código ni respuestas en los logs. La telemetría está desactivada y no se envían datos a terceros.',
    };
  });

  app.delete('/api/privacy/data', async (request) => {
    const { user } = requireAuth(request);
    const body = z
      .object({
        scope: z.enum(['history', 'backups', 'all']),
        confirmation: z.literal('BORRAR'),
      })
      .parse(request.body);
    let conversations = 0;
    let backupCount = 0;
    if (body.scope === 'history' || body.scope === 'all') {
      conversations = store.deleteAllConversations(user.id);
    }
    if (body.scope === 'backups' || body.scope === 'all') {
      backupCount = await backups.deleteAllForUser(user.id);
    }
    return { ok: true, deleted: { conversations, backups: backupCount } };
  });
}
