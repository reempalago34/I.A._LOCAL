import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/hooks.js';
import type { CommandService } from './service.js';

const commandSchema = z.object({
  projectId: z.string().uuid(),
  command: z.string().trim().min(1).max(500),
});

export function registerCommandRoutes(
  app: FastifyInstance,
  options: { commands: CommandService },
): void {
  const { commands } = options;

  app.post('/api/commands/analyze', async (request) => {
    const { user } = requireAuth(request);
    const body = commandSchema.parse(request.body);
    return commands.analyze(user, body.projectId, body.command);
  });

  app.post('/api/commands/execute', async (request) => {
    const { user } = requireAuth(request);
    const body = commandSchema.extend({ confirmation: z.literal('EJECUTAR') }).parse(request.body);
    const result = await commands.execute(user, body.projectId, body.command);
    request.log.info(
      {
        userId: user.id,
        projectId: body.projectId,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
      },
      'Comando ejecutado con aprobación explícita',
    );
    return result;
  });
}
