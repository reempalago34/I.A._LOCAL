import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthService } from '../src/auth/service.js';
import { CommandService } from '../src/commands/service.js';
import type { AppConfig } from '../src/config.js';
import { openDatabase, Store } from '../src/db.js';
import { FileSandbox } from '../src/files/sandbox.js';
import type { ProjectRecord, UserRecord } from '../src/types.js';
import { makeTempDir, makeTestConfig } from './helpers.js';

async function setup(config: AppConfig): Promise<{
  dir: string;
  store: Store;
  user: UserRecord;
  project: ProjectRecord;
  sandbox: FileSandbox;
  cleanup: () => Promise<void>;
}> {
  const dir = await makeTempDir('forge-commands-');
  const store = new Store(openDatabase(':memory:'));
  const auth = new AuthService(store, config);
  const user = await auth.createUser({
    email: 'commands@example.test',
    password: 'Forge-Test-Pass-2026',
    displayName: 'Commands',
  });
  const sandbox = new FileSandbox(config.projectsRoot);
  await sandbox.ensureRoot();
  await mkdir(path.join(config.projectsRoot, 'demo'), { recursive: true });
  await writeFile(path.join(config.projectsRoot, 'demo', 'package.json'), '{"name":"demo"}');
  const project = store.createProject({
    id: randomUUID(),
    userId: user.id,
    name: 'demo',
    rootPath: 'demo',
    now: Date.now(),
  });
  return {
    dir,
    store,
    user,
    project,
    sandbox,
    cleanup: async () => {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe('ejecución de comandos', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it('analiza sin ejecutar y respeta la allowlist', async () => {
    const dir = await makeTempDir();
    const context = await setup(makeTestConfig(dir));
    cleanup = context.cleanup;
    const service = new CommandService(makeTestConfig(dir), context.store, context.sandbox);

    const allowed = await service.analyze(context.user, context.project.id, 'npm test');
    expect(allowed).toMatchObject({
      command: 'npm test',
      allowed: true,
      enabled: false,
      argv: ['npm', 'test'],
      cwd: 'demo',
    });
    expect(allowed.effects).toContain('No hay aislamiento de contenedor');

    const deniedBinary = await service.analyze(context.user, context.project.id, 'rm -rf .');
    expect(deniedBinary.allowed).toBe(false);
    expect(deniedBinary.reason).toContain('no está en la lista permitida');

    const deniedShell = await service.analyze(
      context.user,
      context.project.id,
      'npm test && rm -rf .',
    );
    expect(deniedShell.allowed).toBe(false);
    expect(deniedShell.reason).toContain('operadores de shell');

    const deniedPath = await service.analyze(context.user, context.project.id, '/usr/bin/npm test');
    expect(deniedPath.allowed).toBe(false);
  });

  it('bloquea la ejecución si está deshabilitada', async () => {
    const dir = await makeTempDir();
    const context = await setup(makeTestConfig(dir));
    cleanup = context.cleanup;
    const service = new CommandService(makeTestConfig(dir), context.store, context.sandbox);
    await expect(
      service.execute(context.user, context.project.id, 'npm test'),
    ).rejects.toMatchObject({ code: 'COMMANDS_DISABLED' });
  });

  it('ejecuta con aprobación explícita, sin shell y con entorno mínimo', async () => {
    const dir = await makeTempDir();
    const config = makeTestConfig(dir, {
      ENABLE_COMMAND_EXECUTION: 'true',
      COMMAND_ALLOWLIST: 'node',
    });
    const context = await setup(config);
    cleanup = context.cleanup;
    const service = new CommandService(config, context.store, context.sandbox);

    const result = await service.execute(
      context.user,
      context.project.id,
      `node -e "console.log('forge-ok', process.env.SHOULD_NOT_EXIST ?? 'clean')"`,
    );
    expect(result).toMatchObject({
      command: `node -e "console.log('forge-ok', process.env.SHOULD_NOT_EXIST ?? 'clean')"`,
      cwd: 'demo',
      exitCode: 0,
      timedOut: false,
      truncated: false,
    });
    expect(result.stdout).toContain('forge-ok clean');
    expect(result.stderr).toBe('');
  });

  it('rechaza ejecutables no permitidos y no instalados', async () => {
    const dir = await makeTempDir();
    const config = makeTestConfig(dir, {
      ENABLE_COMMAND_EXECUTION: 'true',
      COMMAND_ALLOWLIST: 'node,forge-missing-binary',
    });
    const context = await setup(config);
    cleanup = context.cleanup;
    const service = new CommandService(config, context.store, context.sandbox);

    await expect(
      service.execute(context.user, context.project.id, 'git status'),
    ).rejects.toMatchObject({ code: 'COMMAND_NOT_ALLOWED' });
    await expect(
      service.execute(context.user, context.project.id, 'forge-missing-binary --version'),
    ).rejects.toMatchObject({ code: 'COMMAND_NOT_FOUND' });
  });

  it('corta la salida que supera el límite', async () => {
    const dir = await makeTempDir();
    const config = makeTestConfig(dir, {
      ENABLE_COMMAND_EXECUTION: 'true',
      COMMAND_ALLOWLIST: 'node',
      COMMAND_MAX_OUTPUT_BYTES: '1024',
    });
    const context = await setup(config);
    cleanup = context.cleanup;
    const service = new CommandService(config, context.store, context.sandbox);

    const result = await service.execute(
      context.user,
      context.project.id,
      `node -e "process.stdout.write('x'.repeat(5000))"`,
    );
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1024);
  });

  it('aplica timeout a comandos que no terminan', async () => {
    const dir = await makeTempDir();
    const config = makeTestConfig(dir, {
      ENABLE_COMMAND_EXECUTION: 'true',
      COMMAND_ALLOWLIST: 'node',
      COMMAND_TIMEOUT_MS: '1000',
    });
    const context = await setup(config);
    cleanup = context.cleanup;
    const service = new CommandService(config, context.store, context.sandbox);

    const result = await service.execute(
      context.user,
      context.project.id,
      `node -e "setTimeout(function(){}, 5000)"`,
    );
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(900);
  }, 10_000);

  it('no permite proyectos de otro usuario', async () => {
    const dir = await makeTempDir();
    const context = await setup(makeTestConfig(dir));
    cleanup = context.cleanup;
    const other = context.store.createUser({
      id: randomUUID(),
      email: 'other@example.test',
      displayName: 'Other',
      passwordHash: context.user.passwordHash,
      role: 'user',
      now: Date.now(),
    });
    const service = new CommandService(makeTestConfig(dir), context.store, context.sandbox);
    await expect(service.analyze(other, context.project.id, 'npm test')).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
    });
  });
});
