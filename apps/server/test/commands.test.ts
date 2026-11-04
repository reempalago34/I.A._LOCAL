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
    expect(deniedBinary.reason).toContain('no coincide con ningún comando completo permitido');

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

  it('deniega node eval/print, npx, instalaciones y subcomandos git peligrosos', async () => {
    const dir = await makeTempDir();
    const config = makeTestConfig(dir, {
      COMMAND_ALLOWLIST:
        'node -e,node --eval,node -p,node --print,npx left-pad,npm install,npm ci,npm install-test,npm clean-install-test,npm exec,git -c core.pager=cat status,git commit,git difftool,git --paginate status,git -p status,git --upload-pack=/bin/sh status',
    });
    const context = await setup(config);
    cleanup = context.cleanup;
    const service = new CommandService(config, context.store, context.sandbox);

    const denied = [
      'node -e "console.log(1)"',
      '"node" "--eval" "console.log(1)"',
      'node -p "1+1"',
      'node --print=1',
      'NODE -e "console.log(1)"',
      'npx left-pad',
      'npm install',
      '"npm" "install"',
      'npm ci',
      'npm install-test',
      'npm clean-install-test',
      'npm exec -- ls',
      'git -c core.pager=cat status',
      'git --paginate status',
      'git -p status',
      'git --upload-pack=/bin/sh status',
      'git --git-dir=/tmp/other status',
      'git --work-tree=/tmp status',
      'git commit -m x',
      'git difftool',
    ];
    for (const command of denied) {
      const analysis = await service.analyze(context.user, context.project.id, command);
      expect(analysis.allowed, command).toBe(false);
      expect(analysis.reason, command).toBeTruthy();
    }
  });

  it('distingue mayúsculas y acepta comillas en comandos permitidos', async () => {
    const dir = await makeTempDir();
    const config = makeTestConfig(dir);
    const context = await setup(config);
    cleanup = context.cleanup;
    const service = new CommandService(config, context.store, context.sandbox);

    const uppercase = await service.analyze(context.user, context.project.id, 'NPM test');
    expect(uppercase.allowed).toBe(false);

    const quoted = await service.analyze(
      context.user,
      context.project.id,
      '"git" "status" --short',
    );
    expect(quoted).toMatchObject({
      allowed: true,
      argv: ['git', 'status', '--short'],
    });

    const prefix = await service.analyze(context.user, context.project.id, 'git statusx');
    expect(prefix.allowed).toBe(false);
  });

  it('marca los comandos que ejecutan scripts de package.json', async () => {
    const dir = await makeTempDir();
    const config = makeTestConfig(dir);
    const context = await setup(config);
    cleanup = context.cleanup;
    const service = new CommandService(config, context.store, context.sandbox);

    const script = await service.analyze(context.user, context.project.id, 'npm test');
    expect(script).toMatchObject({ allowed: true, executesScripts: true });
    expect(script.effects).toContain('scripts de package.json');

    const readOnly = await service.analyze(context.user, context.project.id, 'git status');
    expect(readOnly).toMatchObject({ allowed: true, executesScripts: false });
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
      COMMAND_ALLOWLIST: 'node env-check.mjs',
    });
    const context = await setup(config);
    cleanup = context.cleanup;
    await writeFile(
      path.join(config.projectsRoot, 'demo', 'env-check.mjs'),
      "console.log('forge-ok', process.env.SHOULD_NOT_EXIST ?? 'clean');\n",
    );
    const service = new CommandService(config, context.store, context.sandbox);

    const result = await service.execute(context.user, context.project.id, 'node env-check.mjs');
    expect(result).toMatchObject({
      command: 'node env-check.mjs',
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
      COMMAND_ALLOWLIST: 'node --version,forge-missing-binary --version',
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
      COMMAND_ALLOWLIST: 'node emit.mjs',
      COMMAND_MAX_OUTPUT_BYTES: '1024',
    });
    const context = await setup(config);
    cleanup = context.cleanup;
    await writeFile(
      path.join(config.projectsRoot, 'demo', 'emit.mjs'),
      "process.stdout.write('x'.repeat(5000));\n",
    );
    const service = new CommandService(config, context.store, context.sandbox);

    const result = await service.execute(context.user, context.project.id, 'node emit.mjs');
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1024);
  });

  it('aplica timeout a comandos que no terminan', async () => {
    const dir = await makeTempDir();
    const config = makeTestConfig(dir, {
      ENABLE_COMMAND_EXECUTION: 'true',
      COMMAND_ALLOWLIST: 'node hang.mjs',
      COMMAND_TIMEOUT_MS: '1000',
    });
    const context = await setup(config);
    cleanup = context.cleanup;
    await writeFile(
      path.join(config.projectsRoot, 'demo', 'hang.mjs'),
      'setTimeout(function () {}, 5000);\n',
    );
    const service = new CommandService(config, context.store, context.sandbox);

    const result = await service.execute(context.user, context.project.id, 'node hang.mjs');
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
