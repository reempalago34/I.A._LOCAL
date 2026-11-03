import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, createTestUser, type TestApp, type TestSession } from './helpers.js';

describe('endpoints de aplicación', () => {
  let context: TestApp;
  let session: TestSession;
  let projectId: string;

  function headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      cookie: session.cookie,
      'x-csrf-token': session.csrfToken,
      ...extra,
    };
  }

  beforeEach(async () => {
    context = await createTestApp();
    session = await createTestUser(context.auth);
    await mkdir(path.join(context.config.projectsRoot, 'demo', 'src'), { recursive: true });
    await writeFile(
      path.join(context.config.projectsRoot, 'demo', 'src', 'index.ts'),
      'export const value = 1;\n',
    );
    await writeFile(path.join(context.config.projectsRoot, 'demo', '.env'), 'TOKEN=nope\n');
    const project = context.store.createProject({
      id: randomUUID(),
      userId: session.user.id,
      name: 'demo',
      rootPath: 'demo',
      now: Date.now(),
    });
    projectId = project.id;
  });

  afterEach(async () => {
    await context.cleanup();
  });

  it('responde a health checks sin autenticación', async () => {
    const health = await context.app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });
    expect(health.headers['cache-control']).toBe('no-store');

    const ready = await context.app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ready' });
  });

  it('lista el workspace y bloquea traversal', async () => {
    const ok = await context.app.inject({
      method: 'GET',
      url: '/api/workspace?path=demo',
      headers: headers(),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().entries.some((entry: { name: string }) => entry.name === 'src')).toBe(true);

    const traversal = await context.app.inject({
      method: 'GET',
      url: '/api/workspace?path=../',
      headers: headers(),
    });
    expect(traversal.statusCode).toBe(400);
    expect(traversal.json().error.code).toBe('PATH_TRAVERSAL');
  });

  it('registra proyectos y lista su árbol', async () => {
    const list = await context.app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: headers(),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().projects).toHaveLength(1);

    const tree = await context.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/tree`,
      headers: headers(),
    });
    expect(tree.statusCode).toBe(200);
    expect(tree.json().entries[0]).toMatchObject({ name: 'src', type: 'directory' });

    const traversal = await context.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/tree?path=..%2F..`,
      headers: headers(),
    });
    expect(traversal.statusCode).toBe(400);

    const invalid = await context.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: headers(),
      payload: { path: '../outside' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('PATH_TRAVERSAL');
  });

  it('previsualiza el contexto exacto y reporta archivos rechazados', async () => {
    const preview = await context.app.inject({
      method: 'POST',
      url: '/api/context/preview',
      headers: headers(),
      payload: { projectId, paths: ['src/index.ts', '.env'] },
    });
    expect(preview.statusCode).toBe(200);
    const body = preview.json();
    expect(body.files).toHaveLength(1);
    expect(body.files[0].path).toBe('src/index.ts');
    expect(body.files[0].content).toBe('export const value = 1;\n');
    expect(body.formatted).toContain('<<<FORGE_CONTEXT_FILE>>> path="src/index.ts"');
    expect(body.errors[0].code).toBe('FILE_EXCLUDED');
    expect(body.truncated).toBe(true);
    expect(body.disclaimer).toContain('no se guardan');
  });

  it('valida y actualiza ajustes del usuario', async () => {
    const get = await context.app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: headers(),
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().settings).toMatchObject({
      runtimeUrl: 'http://127.0.0.1:11434',
      persistHistory: false,
      language: 'es',
      theme: 'system',
    });
    expect(get.json().server.telemetryEnabled).toBe(false);
    expect(get.json().server.commandExecutionEnabled).toBe(false);

    const unknown = await context.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: headers(),
      payload: { notASetting: true },
    });
    expect(unknown.statusCode).toBe(400);

    const badRuntime = await context.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: headers(),
      payload: { runtimeUrl: 'http://evil.example:11434' },
    });
    expect(badRuntime.statusCode).toBe(403);
    expect(badRuntime.json().error.code).toBe('RUNTIME_HOST_NOT_ALLOWED');

    const badLimits = await context.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: headers(),
      payload: { maxFileBytes: 200_000, maxContextBytes: 100_000 },
    });
    expect(badLimits.statusCode).toBe(400);
    expect(badLimits.json().error.code).toBe('INVALID_LIMITS');

    const ok = await context.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: headers(),
      payload: {
        theme: 'dark',
        language: 'en',
        maxFileBytes: 1_024,
        excludePatterns: ['fixtures/**', '!negation'],
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().settings.theme).toBe('dark');
    expect(ok.json().settings.excludePatterns).toEqual(['fixtures/**']);

    const reset = await context.app.inject({
      method: 'DELETE',
      url: '/api/settings',
      headers: headers(),
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().settings.theme).toBe('system');
  });

  it('gestiona conversaciones solo cuando el historial está disponible', async () => {
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: headers(),
      payload: { title: 'Prueba', projectId },
    });
    expect(created.statusCode).toBe(200);
    const conversationId = created.json().conversation.id as string;

    const list = await context.app.inject({
      method: 'GET',
      url: '/api/conversations',
      headers: headers(),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().conversations[0]).toMatchObject({ id: conversationId, messageCount: 0 });

    const detail = await context.app.inject({
      method: 'GET',
      url: `/api/conversations/${conversationId}`,
      headers: headers(),
    });
    expect(detail.statusCode).toBe(200);

    const chat = await context.app.inject({
      method: 'POST',
      url: '/api/chat',
      headers: headers(),
      payload: { message: 'Hola', model: 'llama3', conversationId },
    });
    expect(chat.statusCode).toBe(409);
    expect(chat.json().error.code).toBe('HISTORY_DISABLED');

    const deleted = await context.app.inject({
      method: 'DELETE',
      url: `/api/conversations/${conversationId}`,
      headers: headers(),
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true });
  });

  it('analiza comandos y bloquea su ejecución si está deshabilitada', async () => {
    const allowed = await context.app.inject({
      method: 'POST',
      url: '/api/commands/analyze',
      headers: headers(),
      payload: { projectId, command: 'npm test' },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ allowed: true, enabled: false, argv: ['npm', 'test'] });

    const denied = await context.app.inject({
      method: 'POST',
      url: '/api/commands/analyze',
      headers: headers(),
      payload: { projectId, command: 'rm -rf .' },
    });
    expect(denied.statusCode).toBe(200);
    expect(denied.json().allowed).toBe(false);

    const execute = await context.app.inject({
      method: 'POST',
      url: '/api/commands/execute',
      headers: headers(),
      payload: { projectId, command: 'npm test', confirmation: 'EJECUTAR' },
    });
    expect(execute.statusCode).toBe(403);
    expect(execute.json().error.code).toBe('COMMANDS_DISABLED');
  });

  it('aplica borrado de datos con confirmación explícita', async () => {
    const privacy = await context.app.inject({
      method: 'GET',
      url: '/api/privacy',
      headers: headers(),
    });
    expect(privacy.statusCode).toBe(200);
    expect(privacy.json()).toMatchObject({ conversations: 0, backups: 0, telemetry: false });

    const wrong = await context.app.inject({
      method: 'DELETE',
      url: '/api/privacy/data',
      headers: headers(),
      payload: { scope: 'all', confirmation: 'NO' },
    });
    expect(wrong.statusCode).toBe(400);

    const ok = await context.app.inject({
      method: 'DELETE',
      url: '/api/privacy/data',
      headers: headers(),
      payload: { scope: 'all', confirmation: 'BORRAR' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().ok).toBe(true);
  });

  it('devuelve 404 JSON para endpoints desconocidos de la API', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/no-existe',
      headers: headers(),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });
});
