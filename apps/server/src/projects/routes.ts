import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/hooks.js';
import type { Store } from '../db.js';
import { sanitizePatterns } from '../files/exclusions.js';
import { normalizeRelativePath } from '../files/paths.js';
import type { FileSandbox } from '../files/sandbox.js';
import type { BackupService } from '../proposals/backups.js';
import type { SettingsService } from '../settings/service.js';
import { AppError } from '../utils/errors.js';

export function registerProjectRoutes(
  app: FastifyInstance,
  options: {
    store: Store;
    sandbox: FileSandbox;
    settings: SettingsService;
    backups: BackupService;
  },
): void {
  const { store, sandbox, settings, backups } = options;

  app.get('/api/workspace', async (request) => {
    requireAuth(request);
    const query = z.object({ path: z.string().max(1024).optional() }).parse(request.query ?? {});
    return sandbox.listWorkspace(query.path ?? '');
  });

  app.get('/api/projects', async (request) => {
    const { user } = requireAuth(request);
    return { projects: store.listProjects(user.id) };
  });

  app.post('/api/projects', async (request) => {
    const { user } = requireAuth(request);
    const body = z
      .object({
        path: z.string().min(1).max(1024),
        name: z.string().trim().min(1).max(80).optional(),
      })
      .parse(request.body);
    const relative = normalizeRelativePath(body.path, false);
    const directory = await sandbox.assertProjectDirectory(relative);
    const existing = store.findProjectByPath(user.id, directory.relativePath);
    if (existing) return { project: existing };
    const project = store.createProject({
      id: randomUUID(),
      userId: user.id,
      name: body.name?.trim() || directory.name.slice(0, 80),
      rootPath: directory.relativePath,
      now: Date.now(),
    });
    return { project };
  });

  app.get('/api/projects/:projectId/tree', async (request) => {
    const { user } = requireAuth(request);
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    const query = z.object({ path: z.string().max(1024).optional() }).parse(request.query ?? {});
    const project = store.findProject(user.id, params.projectId);
    if (!project) throw new AppError(404, 'PROJECT_NOT_FOUND', 'El proyecto no existe.');
    const userSettings = settings.get(user.id);
    return sandbox.listProjectWithLimits(project.rootPath, query.path ?? '', {
      maxFileBytes: userSettings.maxFileBytes,
      maxContextBytes: userSettings.maxContextBytes,
      maxContextFiles: userSettings.maxContextFiles,
      excludePatterns: sanitizePatterns(userSettings.excludePatterns),
    });
  });

  app.delete('/api/projects/:projectId', async (request) => {
    const { user } = requireAuth(request);
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    await backups.deleteForProject(user.id, params.projectId);
    const deleted = store.deleteProject(user.id, params.projectId);
    if (!deleted) throw new AppError(404, 'PROJECT_NOT_FOUND', 'El proyecto no existe.');
    return { ok: true };
  });
}
