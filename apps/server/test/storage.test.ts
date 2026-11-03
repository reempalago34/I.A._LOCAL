import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../src/auth/service.js';
import { openDatabase, Store } from '../src/db.js';
import { BackupService } from '../src/proposals/backups.js';
import { SettingsService } from '../src/settings/service.js';
import { StorageService } from '../src/storage/service.js';
import {
  createTestApp,
  createTestUser,
  makeTempDir,
  makeTestConfig,
  type TestApp,
  type TestSession,
} from './helpers.js';

describe('almacenamiento', () => {
  let context: TestApp;
  let session: TestSession;

  function headers(extra: Record<string, string> = {}): Record<string, string> {
    return { cookie: session.cookie, 'x-csrf-token': session.csrfToken, ...extra };
  }

  beforeEach(async () => {
    context = await createTestApp();
    session = await createTestUser(context.auth);
  });

  afterEach(async () => {
    await context.cleanup();
  });

  it('informa del uso y del límite por usuario', async () => {
    const empty = await context.app.inject({
      method: 'GET',
      url: '/api/storage',
      headers: headers(),
    });
    expect(empty.statusCode).toBe(200);
    const emptyBody = empty.json() as {
      usage: { trackedBytes: number; limitBytes: number; serverLimitBytes: number };
      note: string;
    };
    expect(emptyBody.usage.trackedBytes).toBe(0);
    expect(emptyBody.usage.limitBytes).toBe(context.config.maxStorageBytes);
    expect(emptyBody.usage.serverLimitBytes).toBe(context.config.maxStorageBytes);
    expect(emptyBody.note).toContain('conversaciones');

    const conversationId = randomUUID();
    context.store.createConversation({
      id: conversationId,
      userId: session.user.id,
      projectId: null,
      title: 'Conversación de prueba',
      model: 'llama3',
      now: Date.now(),
    });
    context.store.createMessage({
      id: randomUUID(),
      conversationId,
      role: 'user',
      content: 'x'.repeat(2_048),
      model: null,
      now: Date.now(),
    });

    const used = await context.app.inject({
      method: 'GET',
      url: '/api/storage',
      headers: headers(),
    });
    const usedBody = used.json() as {
      usage: {
        conversations: { count: number; messages: number; bytes: number };
        trackedBytes: number;
        overLimit: boolean;
      };
    };
    expect(usedBody.usage.conversations.count).toBe(1);
    expect(usedBody.usage.conversations.messages).toBe(1);
    expect(usedBody.usage.conversations.bytes).toBeGreaterThan(2_048);
    expect(usedBody.usage.overLimit).toBe(false);
  });

  it('permite limitar el almacenamiento y detecta el exceso', async () => {
    const conversationId = randomUUID();
    context.store.createConversation({
      id: conversationId,
      userId: session.user.id,
      projectId: null,
      title: 'Grande',
      model: null,
      now: Date.now(),
    });
    context.store.createMessage({
      id: randomUUID(),
      conversationId,
      role: 'assistant',
      content: 'y'.repeat(1_200_000),
      model: null,
      now: Date.now(),
    });

    const lowered = await context.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: headers(),
      payload: { maxStorageBytes: 1_048_576 },
    });
    expect(lowered.statusCode).toBe(200);
    expect(lowered.json().settings.maxStorageBytes).toBe(1_048_576);

    const response = await context.app.inject({
      method: 'GET',
      url: '/api/storage',
      headers: headers(),
    });
    const body = response.json() as {
      usage: { limitBytes: number; trackedBytes: number; overLimit: boolean };
    };
    expect(body.usage.limitBytes).toBe(1_048_576);
    expect(body.usage.trackedBytes).toBeGreaterThan(1_048_576);
    expect(body.usage.overLimit).toBe(true);
  });

  it('rechaza límites fuera de rango', async () => {
    const tooLow = await context.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: headers(),
      payload: { maxStorageBytes: 1_024 },
    });
    expect(tooLow.statusCode).toBe(400);

    const tooHigh = await context.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: headers(),
      payload: { maxStorageBytes: context.config.maxStorageBytes + 1 },
    });
    expect(tooHigh.statusCode).toBe(400);
  });

  it('borra temporales y propuestas en memoria con confirmación', async () => {
    const temporaryDir = path.join(context.config.dataDir, 'tmp');
    await mkdir(temporaryDir, { recursive: true });
    await writeFile(path.join(temporaryDir, 'resto.bin'), 'temporal');

    const withoutConfirmation = await context.app.inject({
      method: 'DELETE',
      url: '/api/storage/temp',
      headers: headers(),
      payload: {},
    });
    expect(withoutConfirmation.statusCode).toBe(400);

    const response = await context.app.inject({
      method: 'DELETE',
      url: '/api/storage/temp',
      headers: headers(),
      payload: { confirmation: 'BORRAR' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true });
    await expect(readFile(path.join(temporaryDir, 'resto.bin'))).rejects.toThrow();
  });
});

describe('StorageService', () => {
  let dir: string;
  let store: Store;
  let config: ReturnType<typeof makeTestConfig>;
  let service: StorageService;

  beforeEach(async () => {
    dir = await makeTempDir('forge-storage-');
    config = makeTestConfig(dir);
    store = new Store(openDatabase(':memory:'));
    const backups = new BackupService(store, config);
    await backups.ensure();
    service = new StorageService(store, new SettingsService(store, config), backups, config);
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('bloquea escrituras por encima del límite', async () => {
    const auth = new AuthService(store, config);
    const created = await auth.createUser({
      email: 'storage@example.test',
      password: 'Forge-Test-Pass-2026',
      displayName: 'Storage',
    });
    await expect(
      service.assertWithinLimit(created.id, config.maxStorageBytes + 1),
    ).rejects.toMatchObject({ code: 'STORAGE_LIMIT_EXCEEDED', statusCode: 413 });
    await expect(service.assertWithinLimit(created.id, 1_024)).resolves.toBeUndefined();
  });
});
