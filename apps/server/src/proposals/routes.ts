import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/hooks.js';
import type { BackupService } from './backups.js';
import type { ProposalService } from './service.js';

const idSchema = z.object({ proposalId: z.string().uuid() });
const backupIdSchema = z.object({ backupId: z.string().uuid() });

export function registerProposalRoutes(
  app: FastifyInstance,
  options: { proposals: ProposalService; backups: BackupService },
): void {
  const { proposals, backups } = options;

  app.get('/api/proposals', async (request) => {
    const { user } = requireAuth(request);
    return { proposals: proposals.list(user.id) };
  });

  app.post('/api/proposals/:proposalId/apply', async (request) => {
    const { user } = requireAuth(request);
    const params = idSchema.parse(request.params);
    return proposals.apply(user.id, params.proposalId);
  });

  app.post('/api/proposals/:proposalId/reject', async (request) => {
    const { user } = requireAuth(request);
    const params = idSchema.parse(request.params);
    return { proposal: proposals.reject(user.id, params.proposalId) };
  });

  app.get('/api/backups', async (request) => {
    const { user } = requireAuth(request);
    return { backups: proposals.listBackups(user.id) };
  });

  app.post('/api/backups/:backupId/restore', async (request) => {
    const { user } = requireAuth(request);
    const params = backupIdSchema.parse(request.params);
    const body = z
      .object({ force: z.boolean().optional(), confirmation: z.literal('RESTAURAR') })
      .parse(request.body);
    return {
      ok: true,
      ...(await proposals.restore(user.id, params.backupId, body.force ?? false)),
    };
  });

  app.delete('/api/backups/:backupId', async (request) => {
    const { user } = requireAuth(request);
    const params = backupIdSchema.parse(request.params);
    const deleted = await backups.delete(user.id, params.backupId);
    if (!deleted) {
      return { ok: false, message: 'El backup no existe o ya se eliminó.' };
    }
    return { ok: true };
  });
}
