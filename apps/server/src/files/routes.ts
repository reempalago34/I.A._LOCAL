import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/hooks.js';
import type { Store } from '../db.js';
import { limitsFromSettings, previewContext } from '../files/context.js';
import type { FileSandbox } from '../files/sandbox.js';
import type { SettingsService } from '../settings/service.js';
import { AppError } from '../utils/errors.js';

export function registerFileRoutes(
  app: FastifyInstance,
  options: { store: Store; sandbox: FileSandbox; settings: SettingsService },
): void {
  const { store, sandbox, settings } = options;

  app.post('/api/context/preview', async (request) => {
    const { user } = requireAuth(request);
    const body = z
      .object({
        projectId: z.string().uuid(),
        paths: z.array(z.string().max(1024)).max(30),
      })
      .parse(request.body);
    const project = store.findProject(user.id, body.projectId);
    if (!project) {
      throw new AppError(404, 'PROJECT_NOT_FOUND', 'El proyecto no existe o no te pertenece.');
    }
    const userSettings = settings.get(user.id);
    const preview = await previewContext({
      sandbox,
      project,
      paths: body.paths,
      limits: limitsFromSettings(userSettings),
    });
    return {
      ...preview,
      project: { id: project.id, name: project.name },
      disclaimer:
        'Este es el contenido exacto que se añadirá al prompt. Los archivos no se guardan en la base de datos.',
    };
  });
}
