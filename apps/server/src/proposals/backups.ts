import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import type { Store } from '../db.js';
import type { BackupRecord } from '../types.js';
import { AppError } from '../utils/errors.js';

export class BackupService {
  readonly directory: string;
  #ready: Promise<void> | null = null;

  constructor(
    private readonly store: Store,
    private readonly config: AppConfig,
  ) {
    this.directory = path.join(config.dataDir, 'backups');
  }

  async ensure(): Promise<void> {
    if (!this.#ready) {
      this.#ready = (async () => {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await chmod(this.directory, 0o700).catch(() => undefined);
      })();
    }
    return this.#ready;
  }

  async create(input: {
    userId: string;
    projectId: string;
    path: string;
    content: string | null;
    mode: number;
  }): Promise<BackupRecord> {
    await this.ensure();
    const id = randomUUID();
    const now = Date.now();
    const retentionDays = Math.max(this.config.backupRetentionDays, 1);
    const record: BackupRecord = {
      id,
      userId: input.userId,
      projectId: input.projectId,
      path: input.path,
      createdAt: now,
      expiresAt: now + retentionDays * 86_400_000,
      restoredAt: null,
      existed: input.content !== null,
      mode: input.mode,
      postHash: null,
    };
    if (input.content !== null) {
      const filePath = this.#contentPath(id);
      await writeFile(filePath, input.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await chmod(filePath, 0o600).catch(() => undefined);
    }
    try {
      this.store.createBackup(record);
    } catch (error) {
      await unlink(this.#contentPath(id)).catch(() => undefined);
      throw error;
    }
    return record;
  }

  setPostHash(userId: string, backupId: string, postHash: string): void {
    this.store.setBackupPostHash(userId, backupId, postHash);
  }

  async content(record: BackupRecord): Promise<string> {
    if (!record.existed) {
      throw new AppError(
        409,
        'BACKUP_EMPTY',
        'Este backup corresponde a un archivo que no existía.',
      );
    }
    try {
      return await readFile(this.#contentPath(record.id), 'utf8');
    } catch {
      throw new AppError(500, 'BACKUP_MISSING', 'El contenido del backup ya no está disponible.');
    }
  }

  async delete(userId: string, backupId: string): Promise<boolean> {
    const record = this.store.findBackup(userId, backupId);
    if (!record) return false;
    this.store.deleteBackup(userId, backupId);
    await unlink(this.#contentPath(record.id)).catch(() => undefined);
    return true;
  }

  async deleteAllForUser(userId: string): Promise<number> {
    const records = this.store.deleteAllBackups(userId);
    for (const record of records) {
      await unlink(this.#contentPath(record.id)).catch(() => undefined);
    }
    return records.length;
  }

  async deleteForProject(userId: string, projectId: string): Promise<number> {
    const records = this.store.listBackupsForProject(userId, projectId);
    this.store.deleteBackupsForProject(userId, projectId);
    for (const record of records) {
      await unlink(this.#contentPath(record.id)).catch(() => undefined);
    }
    return records.length;
  }

  async cleanupExpired(): Promise<number> {
    const expired = this.store.findExpiredBackups(Date.now());
    for (const record of expired) {
      await unlink(this.#contentPath(record.id)).catch(() => undefined);
    }
    return this.store.deleteExpiredBackups(Date.now());
  }

  #contentPath(id: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      throw new AppError(500, 'INVALID_BACKUP_ID', 'Identificador de backup inválido.');
    }
    return path.join(this.directory, `${id}.bak`);
  }
}
