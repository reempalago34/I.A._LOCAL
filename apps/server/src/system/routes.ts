import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/hooks.js';
import type { AppConfig } from '../config.js';
import type { ProposalService } from '../proposals/service.js';
import { resolveRuntimeTarget } from '../runtime/url-policy.js';
import type { SettingsService } from '../settings/service.js';
import type { StorageService } from '../storage/service.js';
import { collectSystemResources } from './info.js';

export function registerSystemRoutes(
  app: FastifyInstance,
  options: {
    config: AppConfig;
    settings: SettingsService;
    storage: StorageService;
    proposals: ProposalService;
  },
): void {
  const { config, settings, storage, proposals } = options;

  app.get('/api/system/resources', async (request) => {
    const { user } = requireAuth(request);
    const query = z
      .object({
        runtimeUrl: z.string().url().max(2048).optional(),
        model: z.string().max(200).optional(),
      })
      .parse(request.query ?? {});
    const userSettings = settings.get(user.id);
    const target = resolveRuntimeTarget(query.runtimeUrl ?? userSettings.runtimeUrl, config);
    return collectSystemResources({
      config,
      target,
      ...(query.model ? { modelName: query.model } : {}),
      signal: AbortSignal.timeout(15_000),
    });
  });

  app.get('/api/storage', async (request) => {
    const { user } = requireAuth(request);
    const cache = proposals.cacheStats(user.id);
    const usage = await storage.usage(user.id, {
      cacheEntries: cache.entries,
      cacheBytes: cache.bytes,
    });
    return {
      usage,
      note: 'El uso incluye conversaciones guardadas, copias temporales y archivos temporales. Las cachés en memoria se liberan al caducar las propuestas o al reiniciar.',
    };
  });

  app.delete('/api/storage/temp', async (request) => {
    const { user } = requireAuth(request);
    z.object({ confirmation: z.literal('BORRAR') }).parse(request.body ?? {});
    const temporaryDir = path.join(config.dataDir, 'tmp');
    await fs.rm(temporaryDir, { recursive: true, force: true });
    const clearedProposals = proposals.clearCache(user.id);
    const cache = proposals.cacheStats(user.id);
    return {
      ok: true,
      clearedProposals,
      usage: await storage.usage(user.id, {
        cacheEntries: cache.entries,
        cacheBytes: cache.bytes,
      }),
    };
  });
}
