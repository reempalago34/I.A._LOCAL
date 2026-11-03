import { type Dirent, promises as fs } from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import type { Store } from '../db.js';
import type { BackupService } from '../proposals/backups.js';
import type { SettingsService } from '../settings/service.js';
import { AppError } from '../utils/errors.js';

export interface StorageUsage {
  conversations: {
    count: number;
    messages: number;
    bytes: number;
  };
  backups: {
    count: number;
    bytes: number;
  };
  /** Archivos temporales de la aplicación (por ejemplo, restos de operaciones). */
  temporary: {
    bytes: number;
  };
  /** Propuestas en memoria; no ocupan disco, pero se muestran para transparencia. */
  cache: {
    entries: number;
    bytes: number;
  };
  database: {
    bytes: number;
  };
  dataDir: {
    usedBytes: number;
    freeBytes: number;
    totalBytes: number;
  };
  trackedBytes: number;
  limitBytes: number;
  serverLimitBytes: number;
  overLimit: boolean;
}

export class StorageService {
  constructor(
    private readonly store: Store,
    private readonly settings: SettingsService,
    private readonly backups: BackupService,
    private readonly config: AppConfig,
  ) {}

  async usage(
    userId: string,
    options: { cacheEntries?: number; cacheBytes?: number } = {},
  ): Promise<StorageUsage> {
    const stats = this.store.storageStats(userId);
    const userSettings = this.settings.get(userId);
    const backupRecords = this.store.listAllBackupsForUser(userId);
    let backupBytes = 0;
    for (const record of backupRecords) {
      if (!record.existed) continue;
      backupBytes += await fileSize(this.#backupPath(record.id));
    }

    const temporaryBytes = await directorySize(path.join(this.config.dataDir, 'tmp'), 1_000).catch(
      () => 0,
    );
    const databaseBytes =
      (await fileSize(this.config.databasePath)) +
      (await fileSize(`${this.config.databasePath}-wal`)) +
      (await fileSize(`${this.config.databasePath}-shm`));
    const disk = await diskSpace(this.config.dataDir);
    const conversationBytes = stats.conversationBytes + stats.messageBytes + stats.metadataBytes;
    const trackedBytes = conversationBytes + backupBytes + temporaryBytes;
    const limitBytes = userSettings.maxStorageBytes;

    return {
      conversations: {
        count: stats.conversations,
        messages: stats.messages,
        bytes: conversationBytes,
      },
      backups: {
        count: backupRecords.length,
        bytes: backupBytes,
      },
      temporary: { bytes: temporaryBytes },
      cache: {
        entries: options.cacheEntries ?? 0,
        bytes: options.cacheBytes ?? 0,
      },
      database: { bytes: databaseBytes },
      dataDir: disk,
      trackedBytes,
      limitBytes,
      serverLimitBytes: this.config.maxStorageBytes,
      overLimit: trackedBytes > limitBytes,
    };
  }

  async assertWithinLimit(userId: string, additionalBytes: number): Promise<void> {
    const usage = await this.usage(userId);
    const minimumFreeBytes = 32 * 1024 ** 2;
    if (usage.dataDir.freeBytes > 0 && usage.dataDir.freeBytes < minimumFreeBytes) {
      throw new AppError(
        507,
        'DISK_SPACE_LOW',
        'Queda muy poco espacio libre en el volumen de datos. Libera espacio antes de guardar más datos.',
        { details: { freeBytes: usage.dataDir.freeBytes } },
      );
    }
    if (usage.trackedBytes + additionalBytes <= usage.limitBytes) return;
    throw new AppError(
      413,
      'STORAGE_LIMIT_EXCEEDED',
      'Has alcanzado el límite de almacenamiento. Borra datos desde Ajustes o aumenta el límite.',
      {
        details: {
          usedBytes: usage.trackedBytes,
          requestedBytes: additionalBytes,
          limitBytes: usage.limitBytes,
        },
      },
    );
  }

  #backupPath(id: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return path.join(this.backups.directory, '__invalid__');
    return path.join(this.backups.directory, `${id}.bak`);
  }
}

async function fileSize(filePath: string): Promise<number> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

async function directorySize(root: string, maxEntries: number): Promise<number> {
  let total = 0;
  let seen = 0;
  const pending = [root];
  while (pending.length > 0 && seen < maxEntries) {
    const current = pending.pop();
    if (!current) break;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      seen += 1;
      if (seen > maxEntries) break;
      const child = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(child);
      } else if (entry.isFile()) {
        total += await fileSize(child);
      }
    }
  }
  return total;
}

export async function diskSpace(
  directory: string,
): Promise<{ usedBytes: number; freeBytes: number; totalBytes: number }> {
  try {
    const stat = await fs.statfs(directory);
    const blockSize = Number(stat.bsize);
    const totalBytes = Number(stat.blocks) * blockSize;
    const freeBytes = Number(stat.bavail) * blockSize;
    return {
      usedBytes: Math.max(totalBytes - freeBytes, 0),
      freeBytes,
      totalBytes,
    };
  } catch {
    return { usedBytes: 0, freeBytes: 0, totalBytes: 0 };
  }
}
