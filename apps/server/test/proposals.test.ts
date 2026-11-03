import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../src/auth/service.js';
import { openDatabase, Store } from '../src/db.js';
import { FileSandbox } from '../src/files/sandbox.js';
import { BackupService } from '../src/proposals/backups.js';
import { ProposalService } from '../src/proposals/service.js';
import { ProposalStore } from '../src/proposals/store.js';
import { SettingsService } from '../src/settings/service.js';
import { StorageService } from '../src/storage/service.js';
import type { ProjectRecord, UserRecord } from '../src/types.js';
import { AppError } from '../src/utils/errors.js';
import { makeTempDir, makeTestConfig } from './helpers.js';

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

describe('propuestas, backups y restauración', () => {
  let dir: string;
  let store: Store;
  let user: UserRecord;
  let project: ProjectRecord;
  let sandbox: FileSandbox;
  let proposals: ProposalService;
  let backups: BackupService;
  let filePath: string;

  beforeEach(async () => {
    dir = await makeTempDir('forge-proposals-');
    const config = makeTestConfig(dir);
    store = new Store(openDatabase(':memory:'));
    const auth = new AuthService(store, config);
    user = await auth.createUser({
      email: 'proposals@example.test',
      password: 'Forge-Test-Pass-2026',
      displayName: 'Proposals',
    });
    sandbox = new FileSandbox(config.projectsRoot);
    await sandbox.ensureRoot();
    filePath = path.join(config.projectsRoot, 'demo', 'src', 'index.ts');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, 'export const value = 1;\n');
    project = store.createProject({
      id: randomUUID(),
      userId: user.id,
      name: 'demo',
      rootPath: 'demo',
      now: Date.now(),
    });
    backups = new BackupService(store, config);
    await backups.ensure();
    const settings = new SettingsService(store, config);
    proposals = new ProposalService(
      store,
      sandbox,
      settings,
      new ProposalStore(config.proposalTtlMs),
      backups,
      new StorageService(store, settings, backups, config),
      config,
    );
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function createWriteProposal(content: string): Promise<string> {
    const result = await proposals.createFromParsed({
      userId: user.id,
      project,
      parsed: [{ path: 'src/index.ts', action: 'write', content }],
    });
    expect(result.proposals).toHaveLength(1);
    return result.proposals[0]!.id;
  }

  it('crea un diff legible y aplica la propuesta con backup', async () => {
    const id = await createWriteProposal('export const value = 2;\n');
    const listed = proposals.list(user.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ path: 'src/index.ts', action: 'write', status: 'pending' });
    expect(listed[0]?.diff).toContain('--- a/src/index.ts');
    expect(listed[0]?.diff).toContain('+++ b/src/index.ts');
    expect(listed[0]?.diff).toContain('-export const value = 1;');
    expect(listed[0]?.diff).toContain('+export const value = 2;');
    expect(listed[0]?.stats).toMatchObject({ additions: 1, deletions: 1, hunks: 1 });

    const applied = await proposals.apply(user.id, id);
    expect(applied).toMatchObject({ path: 'src/index.ts', action: 'write' });
    expect(await readFile(filePath, 'utf8')).toBe('export const value = 2;\n');
    expect(proposals.list(user.id)[0]?.status).toBe('applied');
    expect(proposals.listBackups(user.id)).toHaveLength(1);

    await expectCode(proposals.apply(user.id, id), 'PROPOSAL_NOT_PENDING');
  });

  it('restaura el contenido anterior y marca el backup como usado', async () => {
    const id = await createWriteProposal('export const value = 2;\n');
    const { backupId } = await proposals.apply(user.id, id);
    const restored = await proposals.restore(user.id, backupId, false);
    expect(restored.path).toBe('src/index.ts');
    expect(await readFile(filePath, 'utf8')).toBe('export const value = 1;\n');
    await expectCode(proposals.restore(user.id, backupId, false), 'ALREADY_RESTORED');
  });

  it('crea archivos nuevos y los elimina al restaurar', async () => {
    const result = await proposals.createFromParsed({
      userId: user.id,
      project,
      parsed: [{ path: 'src/new.ts', action: 'write', content: 'export const created = true;\n' }],
    });
    const applied = await proposals.apply(user.id, result.proposals[0]!.id);
    const createdPath = path.join(path.dirname(filePath), 'new.ts');
    expect(await readFile(createdPath, 'utf8')).toBe('export const created = true;\n');
    await proposals.restore(user.id, applied.backupId, false);
    await expect(readFile(createdPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('elimina archivos y los recrea al restaurar', async () => {
    const result = await proposals.createFromParsed({
      userId: user.id,
      project,
      parsed: [{ path: 'src/index.ts', action: 'delete', content: '' }],
    });
    expect(result.proposals[0]?.action).toBe('delete');
    const applied = await proposals.apply(user.id, result.proposals[0]!.id);
    await expect(readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await proposals.restore(user.id, applied.backupId, false);
    expect(await readFile(filePath, 'utf8')).toBe('export const value = 1;\n');
  });

  it('rechaza aplicar si el archivo cambió desde la propuesta', async () => {
    const id = await createWriteProposal('export const value = 2;\n');
    await writeFile(filePath, 'export const value = 99;\n');
    const error = await expectCode(proposals.apply(user.id, id), 'FILE_CHANGED');
    expect(error.statusCode).toBe(409);
    expect(await readFile(filePath, 'utf8')).toBe('export const value = 99;\n');
  });

  it('rechaza restaurar sin force si el archivo cambió después', async () => {
    const id = await createWriteProposal('export const value = 2;\n');
    const { backupId } = await proposals.apply(user.id, id);
    await writeFile(filePath, 'manual edit\n');
    const error = await expectCode(proposals.restore(user.id, backupId, false), 'BACKUP_CONFLICT');
    expect(error.details).toEqual({ requiresForce: true });

    await proposals.restore(user.id, backupId, true);
    expect(await readFile(filePath, 'utf8')).toBe('export const value = 1;\n');
  });

  it('omite propuestas sin cambios, duplicadas o para borrar inexistentes', async () => {
    const result = await proposals.createFromParsed({
      userId: user.id,
      project,
      parsed: [
        { path: 'src/index.ts', action: 'write', content: 'export const value = 1;\n' },
        { path: 'src/missing.ts', action: 'delete', content: '' },
      ],
    });
    expect(result.proposals).toHaveLength(0);
    expect(result.skipped).toBe(2);
    expect(result.warnings).toHaveLength(2);
  });

  it('permite rechazar propuestas y no aplicarlas', async () => {
    const id = await createWriteProposal('export const value = 2;\n');
    const rejected = proposals.reject(user.id, id);
    expect(rejected.status).toBe('rejected');
    await expectCode(proposals.apply(user.id, id), 'PROPOSAL_NOT_FOUND');
    expect(await readFile(filePath, 'utf8')).toBe('export const value = 1;\n');
  });

  it('aísla las propuestas por usuario', async () => {
    const id = await createWriteProposal('export const value = 2;\n');
    const other = store.createUser({
      id: randomUUID(),
      email: 'other@example.test',
      displayName: 'Other',
      passwordHash: user.passwordHash,
      role: 'user',
      now: Date.now(),
    });
    await expectCode(proposals.apply(other.id, id), 'PROPOSAL_NOT_FOUND');
    expect(proposals.list(other.id)).toHaveLength(0);
  });
});
