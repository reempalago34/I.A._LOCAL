import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/hooks.js';
import type { Store } from '../db.js';
import { AppError } from '../utils/errors.js';

const idParams = z.object({ conversationId: z.string().uuid() });

export function registerConversationRoutes(app: FastifyInstance, options: { store: Store }): void {
  const { store } = options;

  app.get('/api/conversations', async (request) => {
    const { user } = requireAuth(request);
    return {
      conversations: store.listConversations(user.id).map((conversation) => ({
        ...conversation,
        messageCount: store.countMessages(conversation.id),
      })),
    };
  });

  app.post('/api/conversations', async (request) => {
    const { user } = requireAuth(request);
    const body = z
      .object({
        title: z.string().trim().min(1).max(120).optional(),
        projectId: z.string().uuid().optional(),
        model: z.string().max(200).optional(),
      })
      .parse(request.body ?? {});
    if (body.projectId && !store.findProject(user.id, body.projectId)) {
      throw new AppError(404, 'PROJECT_NOT_FOUND', 'El proyecto no existe.');
    }
    const conversation = store.createConversation({
      id: randomUUID(),
      userId: user.id,
      projectId: body.projectId ?? null,
      title: body.title?.trim() || 'Nueva conversación',
      model: body.model ?? null,
      now: Date.now(),
    });
    return { conversation };
  });

  app.get('/api/conversations/:conversationId', async (request) => {
    const { user } = requireAuth(request);
    const params = idParams.parse(request.params);
    const conversation = store.findConversation(user.id, params.conversationId);
    if (!conversation) {
      throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'La conversación no existe.');
    }
    return {
      conversation,
      messages: store.listRecentMessages(conversation.id, 200),
    };
  });

  app.patch('/api/conversations/:conversationId', async (request) => {
    const { user } = requireAuth(request);
    const params = idParams.parse(request.params);
    const body = z
      .object({
        title: z.string().trim().min(1).max(120).optional(),
        projectId: z.string().uuid().nullable().optional(),
        model: z.string().max(200).nullable().optional(),
      })
      .strict()
      .parse(request.body ?? {});
    if (body.projectId && !store.findProject(user.id, body.projectId)) {
      throw new AppError(404, 'PROJECT_NOT_FOUND', 'El proyecto no existe.');
    }
    const updated = store.updateConversation(
      user.id,
      params.conversationId,
      {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
        ...(body.model !== undefined ? { model: body.model } : {}),
      },
      Date.now(),
    );
    if (!updated) {
      throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'La conversación no existe.');
    }
    return { conversation: updated };
  });

  app.delete('/api/conversations/:conversationId', async (request) => {
    const { user } = requireAuth(request);
    const params = idParams.parse(request.params);
    const deleted = store.deleteConversation(user.id, params.conversationId);
    if (!deleted) {
      throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'La conversación no existe.');
    }
    return { ok: true };
  });
}
