import { mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FileLimits, FileSandbox, makeLimits } from '../src/files/sandbox.js';
import { AppError } from '../src/utils/errors.js';
import { makeTempDir } from './helpers.js';

async function expectCode(promise: Promise<unknown>, code: string): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return error as AppError;
  }
  throw new Error(`Se esperaba un error ${code}`);
}

describe('FileSandbox', () => {
  let dir: string;
  let root: string;
  let sandbox: FileSandbox;
  let limits: FileLimits;

  beforeEach(async () => {
    dir = await makeTempDir('forge-sandbox-');
    root = path.join(dir, 'projects');
    sandbox = new FileSandbox(root);
    await sandbox.ensureRoot();
    await mkdir(path.join(root, 'app', 'src'), { recursive: true });
    await writeFile(path.join(root, 'app', 'src', 'index.ts'), 'export const value = 1;\n');
    await mkdir(path.join(root, 'app', 'node_modules', 'pkg'), { recursive: true });
    await writeFile(
      path.join(root, 'app', 'node_modules', 'pkg', 'index.js'),
      'module.exports = 1;',
    );
    await writeFile(path.join(root, 'app', '.env'), 'SECRET=super-secret\n');
    await writeFile(path.join(dir, 'outside.txt'), 'outside\n');
    limits = makeLimits({
      maxFileBytes: 1024,
      maxContextBytes: 4096,
      maxContextFiles: 4,
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('crea la raíz y resuelve proyectos válidos', async () => {
    const real = await sandbox.ensureRoot();
    expect(real).toBe(await realpath(root));
    await expect(sandbox.resolveProjectBase('app')).resolves.toBe(path.join(real, 'app'));
  });

  it('bloquea traversal y symlinks al resolver el proyecto', async () => {
    await expectCode(sandbox.resolveProjectBase('../outside'), 'PATH_TRAVERSAL');
    await expectCode(sandbox.resolveProjectBase('missing'), 'PATH_NOT_FOUND');

    await symlink(path.join(dir, 'outside.txt'), path.join(root, 'link-project'));
    await expectCode(sandbox.resolveProjectBase('link-project'), 'SYMLINK_BLOCKED');
  });

  it('lista el workspace ocultando exclusiones y marcando symlinks', async () => {
    await symlink(path.join(dir, 'outside.txt'), path.join(root, 'app', 'outside-link.txt'));
    await mkdir(path.join(root, 'app', '.hidden'), { recursive: true });

    const listing = await sandbox.listWorkspace('app');
    const names = listing.entries.map((entry) => entry.name);
    expect(names).toContain('src');
    expect(names).not.toContain('node_modules');
    expect(names).not.toContain('.env');
    expect(names).not.toContain('.hidden');
    const blocked = listing.entries.find((entry) => entry.name === 'outside-link.txt');
    expect(blocked).toMatchObject({ type: 'blocked', blocked: true });
  });

  it('lista archivos con tamaños y aplica patrones personalizados', async () => {
    await writeFile(path.join(root, 'app', 'notes.md'), '# notas\n');
    await mkdir(path.join(root, 'app', 'fixtures'), { recursive: true });
    await writeFile(path.join(root, 'app', 'fixtures', 'data.json'), '{}');

    const rootListing = await sandbox.listProjectWithLimits('app', '', {
      ...limits,
      excludePatterns: ['fixtures/**'],
    });
    expect(rootListing.entries.some((entry) => entry.name === 'src')).toBe(true);
    expect(rootListing.entries.some((entry) => entry.name === 'fixtures')).toBe(false);

    const listing = await sandbox.listProjectWithLimits('app', 'src', limits);
    const file = listing.entries.find((entry) => entry.name === 'index.ts');
    expect(file?.type).toBe('file');
    expect(file?.size).toBeGreaterThan(0);
  });

  it('lee archivos de texto y calcula hash, líneas y modo', async () => {
    const file = await sandbox.readTextFile('app', 'src/index.ts', limits);
    expect(file.content).toBe('export const value = 1;\n');
    expect(file.bytes).toBe(Buffer.byteLength(file.content));
    expect(file.lines).toBe(2);
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(file.mode).toBeGreaterThan(0);
  });

  it('lee archivos grandes por fragmentos sin reservar el tamaño completo', async () => {
    const content = 'a'.repeat(150_000);
    await writeFile(path.join(root, 'app', 'chunked.txt'), content);
    const file = await sandbox.readTextFile('app', 'chunked.txt', {
      ...limits,
      maxFileBytes: 200_000,
    });
    expect(file.bytes).toBe(150_000);
    expect(file.content.length).toBe(150_000);
    expect(file.content).toBe(content);
  });

  it('rechaza archivos excluidos, binarios, no UTF-8 y demasiado grandes', async () => {
    await expectCode(sandbox.readTextFile('app', '.env', limits), 'FILE_EXCLUDED');
    await expectCode(sandbox.readTextFile('app', 'src/../.env', limits), 'PATH_TRAVERSAL');

    await writeFile(path.join(root, 'app', 'binary.dat'), Buffer.from([0x00, 0x01, 0x02]));
    await expectCode(sandbox.readTextFile('app', 'binary.dat', limits), 'BINARY_FILE');

    await writeFile(path.join(root, 'app', 'latin1.txt'), Buffer.from([0xff, 0xfe, 0x41]));
    await expectCode(sandbox.readTextFile('app', 'latin1.txt', limits), 'INVALID_ENCODING');

    await writeFile(path.join(root, 'app', 'large.txt'), 'x'.repeat(2048));
    await expectCode(sandbox.readTextFile('app', 'large.txt', limits), 'FILE_TOO_LARGE');
  });

  it('bloquea lectura a través de symlinks', async () => {
    await symlink(path.join(dir, 'outside.txt'), path.join(root, 'app', 'src', 'link.txt'));
    await expectCode(sandbox.readTextFile('app', 'src/link.txt', limits), 'SYMLINK_BLOCKED');
    await expectCode(sandbox.readTextFile('app', 'src', limits), 'NOT_A_FILE');
  });

  it('escribe de forma atómica respetando hashes esperados', async () => {
    const created = await sandbox.writeFileAtomic({
      projectRoot: 'app',
      path: 'src/new.ts',
      content: 'export const created = true;\n',
      expectedHash: null,
      maxBytes: 4096,
    });
    expect(created.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await readFile(path.join(root, 'app', 'src', 'new.ts'), 'utf8')).toBe(
      'export const created = true;\n',
    );

    await expectCode(
      sandbox.writeFileAtomic({
        projectRoot: 'app',
        path: 'src/new.ts',
        content: 'overwrite',
        expectedHash: null,
        maxBytes: 4096,
      }),
      'FILE_EXISTS',
    );

    const current = await sandbox.hashFile('app', 'src/new.ts');
    await expectCode(
      sandbox.writeFileAtomic({
        projectRoot: 'app',
        path: 'src/new.ts',
        content: 'changed',
        expectedHash: 'deadbeef',
        maxBytes: 4096,
      }),
      'FILE_CHANGED',
    );

    await sandbox.writeFileAtomic({
      projectRoot: 'app',
      path: 'src/new.ts',
      content: 'changed',
      expectedHash: current,
      maxBytes: 4096,
    });
    expect(await readFile(path.join(root, 'app', 'src', 'new.ts'), 'utf8')).toBe('changed');
  });

  it('rechaza escrituras en rutas excluidas, reservadas o sin carpeta', async () => {
    await expectCode(
      sandbox.writeFileAtomic({
        projectRoot: 'app',
        path: '.git/config',
        content: 'x',
        expectedHash: null,
        maxBytes: 4096,
      }),
      'FILE_EXCLUDED',
    );
    await expectCode(
      sandbox.writeFileAtomic({
        projectRoot: 'app',
        path: 'src/.forge-tmp-abc',
        content: 'x',
        expectedHash: null,
        maxBytes: 4096,
      }),
      'INVALID_PATH',
    );
    await expectCode(
      sandbox.writeFileAtomic({
        projectRoot: 'app',
        path: 'missing/dir/file.ts',
        content: 'x',
        expectedHash: null,
        maxBytes: 4096,
      }),
      'PATH_NOT_FOUND',
    );
    await expectCode(
      sandbox.writeFileAtomic({
        projectRoot: 'app',
        path: 'src/index.ts',
        content: 'x'.repeat(5000),
        expectedHash: await sandbox.hashFile('app', 'src/index.ts'),
        maxBytes: 4096,
      }),
      'FILE_TOO_LARGE',
    );
  });

  it('borra solo con el hash correcto y solo archivos regulares', async () => {
    const hash = await sandbox.hashFile('app', 'src/index.ts');
    await expectCode(
      sandbox.deleteFile({ projectRoot: 'app', path: 'src/index.ts', expectedHash: 'wrong' }),
      'FILE_CHANGED',
    );
    await expectCode(
      sandbox.deleteFile({ projectRoot: 'app', path: 'src', expectedHash: hash ?? '' }),
      'NOT_A_FILE',
    );
    await sandbox.deleteFile({
      projectRoot: 'app',
      path: 'src/index.ts',
      expectedHash: hash ?? '',
    });
    await expect(stat(path.join(root, 'app', 'src', 'index.ts'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(sandbox.hashFile('app', 'src/index.ts')).resolves.toBeNull();
  });

  it('rechaza archivos que crecen entre stat y lectura', async () => {
    // El límite se comprueba también sobre stat; un archivo de exactamente el
    // límite se lee y uno mayor se rechaza, evitando desbordamientos.
    await writeFile(path.join(root, 'app', 'exact.txt'), 'x'.repeat(1024));
    const file = await sandbox.readTextFile('app', 'exact.txt', limits);
    expect(file.bytes).toBe(1024);
  });
});
