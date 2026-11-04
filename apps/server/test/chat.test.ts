import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatUsage, ModelRuntime } from '../src/runtime/types.js';
import { SettingsService } from '../src/settings/service.js';
import { AppError } from '../src/utils/errors.js';
import {
  createTestApp,
  createTestUser,
  parseSse,
  type TestApp,
  type TestSession,
} from './helpers.js';

function fakeRuntime(
  text: string,
  usage: ChatUsage = { promptTokens: 10, completionTokens: 5 },
): ModelRuntime {
  return {
    kind: 'ollama',
    target: 'http://127.0.0.1:11434',
    health: async () => ({ reachable: true, version: 'test', modelCount: 1 }),
    listModels: async () => [],
    getModel: async (name: string) => ({
      name,
      sizeBytes: 0,
      details: {},
      capabilities: {},
      requirements: {
        diskBytes: 0,
        estimatedRamBytes: null,
        estimateQuality: 'unknown',
        notes: [],
      },
    }),
    async *chat() {
      yield { type: 'delta', text };
      yield { type: 'done', usage };
    },
  };
}

async function setupProject(context: TestApp, session: TestSession): Promise<string> {
  const projectDir = path.join(context.config.projectsRoot, 'demo');
  await mkdir(path.join(projectDir, 'src'), { recursive: true });
  await writeFile(path.join(projectDir, 'src', 'index.ts'), 'export const value = 1;\n');
  const project = context.store.createProject({
    id: randomUUID(),
    userId: session.user.id,
    name: 'demo',
    rootPath: 'demo',
    now: Date.now(),
  });
  return project.id;
}

function headers(session: TestSession): Record<string, string> {
  return { cookie: session.cookie, 'x-csrf-token': session.csrfToken };
}

describe('chat y contexto', () => {
  it('transmite SSE, crea propuestas y comandos revisables', async () => {
    const assistantText = `He revisado el archivo.

<proposal path="src/index.ts" action="write">
export const value = 2;
</proposal>
<command>npm test</command>`;
    const context = await createTestApp({}, { runtimeFactory: () => fakeRuntime(assistantText) });
    try {
      const session = await createTestUser(context.auth);
      const projectId = await setupProject(context, session);

      const response = await context.app.inject({
        method: 'POST',
        url: '/api/chat',
        headers: headers(session),
        payload: {
          message: 'Sube el valor a 2',
          model: 'llama3',
          projectId,
          contextPaths: ['src/index.ts'],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      const events = parseSse(response.payload);
      const names = events.map((event) => event.event);
      expect(names).toContain('meta');
      expect(names).toContain('delta');
      expect(names).toContain('proposals');
      expect(names).toContain('commands');
      expect(names).toContain('done');

      const meta = events.find((event) => event.event === 'meta')?.data as {
        runtime: { location: string; executionScope: string };
        context: { files: { path: string }[] };
        persisted: boolean;
      };
      expect(meta.runtime.location).toBe('local');
      expect(meta.runtime.executionScope).toBe('this-computer');
      expect(meta.context.files[0]?.path).toBe('src/index.ts');
      expect(meta.persisted).toBe(false);

      const delta = events.find((event) => event.event === 'delta')?.data as { text: string };
      expect(delta.text).toContain('He revisado el archivo.');

      const proposalEvent = events.find((event) => event.event === 'proposals')?.data as {
        proposals: { id: string; path: string; status: string; diff: string }[];
      };
      expect(proposalEvent.proposals).toHaveLength(1);
      expect(proposalEvent.proposals[0]).toMatchObject({
        path: 'src/index.ts',
        status: 'pending',
      });
      expect(proposalEvent.proposals[0]?.diff).toContain('+export const value = 2;');

      const commandEvent = events.find((event) => event.event === 'commands')?.data as {
        commands: { command: string; allowed: boolean; enabled: boolean }[];
      };
      expect(commandEvent.commands[0]).toMatchObject({
        command: 'npm test',
        allowed: true,
        enabled: false,
      });

      const proposalId = proposalEvent.proposals[0]!.id;
      const apply = await context.app.inject({
        method: 'POST',
        url: `/api/proposals/${proposalId}/apply`,
        headers: headers(session),
      });
      expect(apply.statusCode).toBe(200);
      expect(
        await readFile(path.join(context.config.projectsRoot, 'demo', 'src', 'index.ts'), 'utf8'),
      ).toBe('export const value = 2;\n');

      const restore = await context.app.inject({
        method: 'POST',
        url: `/api/backups/${apply.json().backupId}/restore`,
        headers: headers(session),
        payload: { confirmation: 'RESTAURAR' },
      });
      expect(restore.statusCode).toBe(200);
      expect(
        await readFile(path.join(context.config.projectsRoot, 'demo', 'src', 'index.ts'), 'utf8'),
      ).toBe('export const value = 1;\n');
    } finally {
      await context.cleanup();
    }
  });

  it('exige confirmación APLICAR en la API para propuestas sensibles', async () => {
    const assistantText = `<proposal path="package.json" action="write">
{"name":"demo","private":true}
</proposal>`;
    const context = await createTestApp({}, { runtimeFactory: () => fakeRuntime(assistantText) });
    try {
      const session = await createTestUser(context.auth);
      const projectId = await setupProject(context, session);
      await writeFile(
        path.join(context.config.projectsRoot, 'demo', 'package.json'),
        '{"name":"demo"}\n',
      );

      const response = await context.app.inject({
        method: 'POST',
        url: '/api/chat',
        headers: headers(session),
        payload: { message: 'Actualiza package.json', model: 'llama3', projectId },
      });
      const proposalEvent = parseSse(response.payload).find((event) => event.event === 'proposals')
        ?.data as { proposals: { id: string; path: string; sensitive: boolean }[] };
      expect(proposalEvent.proposals[0]).toMatchObject({
        path: 'package.json',
        sensitive: true,
      });
      const proposalId = proposalEvent.proposals[0]!.id;

      const denied = await context.app.inject({
        method: 'POST',
        url: `/api/proposals/${proposalId}/apply`,
        headers: headers(session),
      });
      expect(denied.statusCode).toBe(400);
      expect(denied.json().error.code).toBe('CONFIRMATION_REQUIRED');

      const applied = await context.app.inject({
        method: 'POST',
        url: `/api/proposals/${proposalId}/apply`,
        headers: headers(session),
        payload: { confirmation: 'APLICAR' },
      });
      expect(applied.statusCode).toBe(200);
      expect(applied.json().proposal).toMatchObject({ path: 'package.json', status: 'applied' });
    } finally {
      await context.cleanup();
    }
  });

  it('avisa cuando el prompt estimado supera la ventana de contexto', async () => {
    const context = await createTestApp(
      { RUNTIME_NUM_CTX: '1000' },
      { runtimeFactory: () => fakeRuntime('ok', { promptTokens: 1_200, completionTokens: 2 }) },
    );
    try {
      const session = await createTestUser(context.auth);
      const response = await context.app.inject({
        method: 'POST',
        url: '/api/chat',
        headers: headers(session),
        payload: { message: 'x'.repeat(5_000), model: 'llama3' },
      });
      expect(response.statusCode).toBe(200);
      const warnings = parseSse(response.payload)
        .filter((event) => event.event === 'warnings')
        .flatMap((event) => (event.data as { warnings: string[] }).warnings);
      expect(warnings.some((warning) => warning.includes('supera la ventana'))).toBe(true);
    } finally {
      await context.cleanup();
    }
  });

  it('avisa de posible truncamiento cuando prompt_eval_count se acerca al límite', async () => {
    const context = await createTestApp(
      { RUNTIME_NUM_CTX: '1000' },
      { runtimeFactory: () => fakeRuntime('ok', { promptTokens: 990, completionTokens: 2 }) },
    );
    try {
      const session = await createTestUser(context.auth);
      const response = await context.app.inject({
        method: 'POST',
        url: '/api/chat',
        headers: headers(session),
        payload: { message: 'Hola', model: 'llama3' },
      });
      expect(response.statusCode).toBe(200);
      const warnings = parseSse(response.payload)
        .filter((event) => event.event === 'warnings')
        .flatMap((event) => (event.data as { warnings: string[] }).warnings);
      expect(warnings.some((warning) => warning.includes('cerca del límite'))).toBe(true);
    } finally {
      await context.cleanup();
    }
  });

  it('avisa cuando Ollama corta la respuesta por el límite de salida', async () => {
    const context = await createTestApp(
      {},
      {
        runtimeFactory: () =>
          fakeRuntime('parcial', {
            promptTokens: 10,
            completionTokens: 50,
            doneReason: 'length',
          }),
      },
    );
    try {
      const session = await createTestUser(context.auth);
      const response = await context.app.inject({
        method: 'POST',
        url: '/api/chat',
        headers: headers(session),
        payload: { message: 'Escribe mucho', model: 'llama3' },
      });
      expect(response.statusCode).toBe(200);
      const warnings = parseSse(response.payload)
        .filter((event) => event.event === 'warnings')
        .flatMap((event) => (event.data as { warnings: string[] }).warnings);
      expect(warnings.some((warning) => warning.includes('se cortó'))).toBe(true);
    } finally {
      await context.cleanup();
    }
  });

  it('exige confirmación antes de enviar archivos a un runtime no local', async () => {
    const context = await createTestApp(
      {
        RUNTIME_ALLOWED_HOSTS: '10.20.30.40',
      },
      { runtimeFactory: () => fakeRuntime('ok') },
    );
    try {
      const session = await createTestUser(context.auth);
      const projectId = await setupProject(context, session);
      const settings = new SettingsService(context.store, context.config);
      settings.update(session.user.id, { runtimeUrl: 'http://10.20.30.40:11434' });

      const request = {
        message: 'Analiza este archivo',
        model: 'llama3',
        projectId,
        contextPaths: ['src/index.ts'],
      };
      let thrown: AppError | null = null;
      try {
        await context.chat.prepare(session.user, request);
      } catch (error) {
        thrown = error as AppError;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect(thrown?.code).toBe('CONTEXT_AUTHORIZATION_REQUIRED');
      expect(thrown?.details).toMatchObject({
        runtimeHost: '10.20.30.40:11434',
        runtimeLocation: 'private',
      });
      const contextFiles = (thrown as AppError).details?.files as { path: string }[];
      expect(contextFiles[0]!.path).toBe('src/index.ts');

      const prepared = await context.chat.prepare(session.user, {
        ...request,
        confirmRemoteContext: true,
      });
      expect(prepared.runtimeLocation).toBe('private');
      expect(prepared.messages.at(-1)?.content).toContain('export const value = 1;');
    } finally {
      await context.cleanup();
    }
  });

  it('valida modelo y proyecto antes de generar', async () => {
    const context = await createTestApp({}, { runtimeFactory: () => fakeRuntime('ok') });
    try {
      const session = await createTestUser(context.auth);
      await expect(
        context.chat.prepare(session.user, { message: 'Hola', model: '' }),
      ).rejects.toMatchObject({ code: 'MODEL_REQUIRED' });
      await expect(
        context.chat.prepare(session.user, { message: 'Hola', model: 'bad model!' }),
      ).rejects.toMatchObject({ code: 'INVALID_MODEL' });
      await expect(
        context.chat.prepare(session.user, {
          message: 'Hola',
          model: 'llama3',
          contextPaths: ['src/index.ts'],
        }),
      ).rejects.toMatchObject({ code: 'PROJECT_REQUIRED' });
      await expect(
        context.chat.prepare(session.user, {
          message: 'Hola',
          model: 'llama3',
          projectId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    } finally {
      await context.cleanup();
    }
  });

  it('persiste historial solo si está habilitado y sin guardar contenido de archivos', async () => {
    const context = await createTestApp({}, { runtimeFactory: () => fakeRuntime('respuesta') });
    try {
      const session = await createTestUser(context.auth);
      const projectId = await setupProject(context, session);
      const settings = new SettingsService(context.store, context.config);
      settings.update(session.user.id, { persistHistory: true });

      const prepared = await context.chat.prepare(session.user, {
        message: 'Revisa el archivo',
        model: 'llama3',
        projectId,
        contextPaths: ['src/index.ts'],
      });
      expect(prepared.persisted).toBe(true);
      expect(prepared.conversation?.title).toBe('Revisa el archivo');

      await context.chat.finalize({
        prepared,
        displayContent: 'respuesta',
        rawContent: 'respuesta',
        proposals: [],
        commands: [],
        warnings: [],
        usage: { promptTokens: 1, completionTokens: 1 },
      });

      const messages = context.store.listRecentMessages(prepared.conversation!.id, 10);
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ role: 'user', content: 'Revisa el archivo' });
      expect(messages[1]?.role).toBe('assistant');
      expect(messages[1]?.content).toBe('respuesta');
      expect(messages[1]?.metadata).toMatchObject({
        rawContentStored: false,
        contextFiles: ['src/index.ts'],
      });
      expect(JSON.stringify(messages[1]?.metadata)).not.toContain('export const value');
    } finally {
      await context.cleanup();
    }
  });

  it('bloquea la persistencia cuando se supera el almacenamiento permitido', async () => {
    const context = await createTestApp({}, { runtimeFactory: () => fakeRuntime('ok') });
    try {
      const session = await createTestUser(context.auth);
      const settings = new SettingsService(context.store, context.config);
      settings.update(session.user.id, { persistHistory: true, maxStorageBytes: 1_048_576 });
      const conversationId = randomUUID();
      context.store.createConversation({
        id: conversationId,
        userId: session.user.id,
        projectId: null,
        title: 'Historial grande',
        model: null,
        now: Date.now(),
      });
      context.store.createMessage({
        id: randomUUID(),
        conversationId,
        role: 'user',
        content: 'z'.repeat(1_100_000),
        model: null,
        now: Date.now(),
      });

      await expect(
        context.chat.prepare(session.user, { message: 'Hola', model: 'llama3' }),
      ).rejects.toMatchObject({ code: 'STORAGE_LIMIT_EXCEEDED', statusCode: 413 });
    } finally {
      await context.cleanup();
    }
  });

  it('limita generaciones concurrentes y por minuto', async () => {
    const context = await createTestApp({ CHAT_RATE_LIMIT_PER_MINUTE: '20' });
    try {
      const session = await createTestUser(context.auth);
      const first = context.chat.acquire(session.user.id);
      expect(() => context.chat.acquire(session.user.id)).toThrow(/Ya hay una generación activa/);
      first.release();
    } finally {
      await context.cleanup();
    }

    const limited = await createTestApp({ CHAT_RATE_LIMIT_PER_MINUTE: '1' });
    try {
      const session = await createTestUser(limited.auth);
      limited.chat.acquire(session.user.id).release();
      expect(() => limited.chat.acquire(session.user.id)).toThrow(
        /límite de generaciones por minuto/,
      );
    } finally {
      await limited.cleanup();
    }
  });

  it('cancela generaciones activas al apagar el servicio', async () => {
    const context = await createTestApp({});
    try {
      const session = await createTestUser(context.auth);
      const access = context.chat.acquire(session.user.id);
      expect(context.chat.activeControllers).toHaveLength(1);
      context.chat.shutdown();
      expect(access.controller.signal.aborted).toBe(true);
      expect(context.chat.activeControllers).toHaveLength(0);
    } finally {
      await context.cleanup();
    }
  });
});
