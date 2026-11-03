import type { AppConfig } from '../config.js';
import type { Store } from '../db.js';
import { estimateTokens, limitsFromSettings } from '../files/context.js';
import type { FileSandbox } from '../files/sandbox.js';
import type { SettingsService } from '../settings/service.js';
import type { StorageService } from '../storage/service.js';
import type { ProjectRecord } from '../types.js';
import { AppError } from '../utils/errors.js';
import type { BackupService } from './backups.js';
import { createUnifiedDiff } from './diff.js';
import { type ProposalStore, type PublicProposal, toPublicProposal } from './store.js';

export interface ProposalCreationResult {
  proposals: PublicProposal[];
  warnings: string[];
  skipped: number;
}

export class ProposalService {
  constructor(
    private readonly store: Store,
    private readonly sandbox: FileSandbox,
    private readonly settings: SettingsService,
    private readonly proposals: ProposalStore,
    private readonly backups: BackupService,
    private readonly storage: StorageService,
    private readonly config: AppConfig,
  ) {}

  async createFromParsed(input: {
    userId: string;
    project: ProjectRecord;
    parsed: { path: string; action: 'write' | 'delete'; content: string }[];
  }): Promise<ProposalCreationResult> {
    const userSettings = this.settings.get(input.userId);
    const limits = limitsFromSettings(userSettings);
    const publicProposals: PublicProposal[] = [];
    const warnings: string[] = [];
    let skipped = 0;

    for (const parsed of input.parsed) {
      try {
        let oldContent: string | null = null;
        let oldHash: string | null = null;
        let oldMode = 0o644;
        try {
          const existing = await this.sandbox.readTextFile(
            input.project.rootPath,
            parsed.path,
            limits,
          );
          oldContent = existing.content;
          oldHash = existing.sha256;
          oldMode = existing.mode;
        } catch (error) {
          if (!(error instanceof AppError) || error.code !== 'FILE_NOT_FOUND') {
            throw error;
          }
        }

        if (parsed.action === 'delete' && oldContent === null) {
          warnings.push(`No se propuso eliminar ${parsed.path}: el archivo no existe.`);
          skipped += 1;
          continue;
        }
        if (parsed.action === 'write' && oldContent === parsed.content) {
          warnings.push(`${parsed.path} no tiene cambios; se omitió la propuesta.`);
          skipped += 1;
          continue;
        }
        const maxProposalBytes = Math.min(this.config.maxFileBytes * 4, 1_048_576);
        if (Buffer.byteLength(parsed.content, 'utf8') > maxProposalBytes) {
          warnings.push(`La propuesta para ${parsed.path} es demasiado grande y se omitió.`);
          skipped += 1;
          continue;
        }

        const { diff, stats } = createUnifiedDiff(
          parsed.path,
          oldContent ?? '',
          parsed.action === 'delete' ? '' : parsed.content,
        );
        const stored = this.proposals.create({
          userId: input.userId,
          projectId: input.project.id,
          path: parsed.path,
          action: parsed.action,
          oldContent,
          newContent: parsed.action === 'delete' ? null : parsed.content,
          oldHash,
          oldMode,
          diff,
          stats,
        });
        publicProposals.push(toPublicProposal(stored));
      } catch (error) {
        skipped += 1;
        warnings.push(
          error instanceof AppError
            ? `${parsed.path}: ${error.message}`
            : `${parsed.path}: no se pudo generar la propuesta.`,
        );
      }
    }
    return { proposals: publicProposals, warnings, skipped };
  }

  async apply(
    userId: string,
    proposalId: string,
  ): Promise<{
    proposal: PublicProposal;
    backupId: string;
    path: string;
    action: 'write' | 'delete';
  }> {
    const proposal = this.proposals.get(userId, proposalId);
    if (!proposal) {
      throw new AppError(
        404,
        'PROPOSAL_NOT_FOUND',
        'La propuesta no existe o caducó. Vuelve a generar los cambios.',
      );
    }
    if (proposal.status !== 'pending') {
      throw new AppError(409, 'PROPOSAL_NOT_PENDING', 'Esta propuesta ya fue procesada.');
    }
    const project = this.store.findProject(userId, proposal.projectId);
    if (!project) {
      throw new AppError(404, 'PROJECT_NOT_FOUND', 'El proyecto ya no está registrado.');
    }
    const userSettings = this.settings.get(userId);
    const limits = limitsFromSettings(userSettings);
    await this.backups.cleanupExpired().catch(() => undefined);
    if (proposal.oldContent !== null) {
      await this.storage.assertWithinLimit(
        userId,
        Buffer.byteLength(proposal.oldContent, 'utf8') + 1_024,
      );
    }

    return this.#withLock(`${proposal.projectId}:${proposal.path}`, async () => {
      if (proposal.action === 'write') {
        const currentHash = await this.sandbox.hashFile(project.rootPath, proposal.path);
        if (currentHash !== proposal.oldHash) {
          throw new AppError(
            409,
            'FILE_CHANGED',
            'El archivo cambió desde que se generó la propuesta. Revisa el diff de nuevo.',
          );
        }
        const backup = await this.backups.create({
          userId,
          projectId: project.id,
          path: proposal.path,
          content: proposal.oldContent,
          mode: proposal.oldMode,
        });
        const result = await this.sandbox.writeFileAtomic({
          projectRoot: project.rootPath,
          path: proposal.path,
          content: proposal.newContent ?? '',
          expectedHash: proposal.oldHash,
          maxBytes: Math.max(
            limits.maxFileBytes,
            Math.min(this.config.maxFileBytes * 4, 1_048_576),
          ),
        });
        this.backups.setPostHash(userId, backup.id, result.sha256);
        this.proposals.markApplied(userId, proposal.id, backup.id);
        return {
          proposal: toPublicProposal(proposal),
          backupId: backup.id,
          path: proposal.path,
          action: proposal.action,
        };
      }

      const currentHash = await this.sandbox.hashFile(project.rootPath, proposal.path);
      if (currentHash === null) {
        throw new AppError(
          404,
          'FILE_NOT_FOUND',
          'El archivo que se quería eliminar ya no existe.',
        );
      }
      if (currentHash !== proposal.oldHash) {
        throw new AppError(
          409,
          'FILE_CHANGED',
          'El archivo cambió desde que se generó la propuesta. Revisa el diff de nuevo.',
        );
      }
      const backup = await this.backups.create({
        userId,
        projectId: project.id,
        path: proposal.path,
        content: proposal.oldContent,
        mode: proposal.oldMode,
      });
      await this.sandbox.deleteFile({
        projectRoot: project.rootPath,
        path: proposal.path,
        expectedHash: currentHash,
      });
      this.backups.setPostHash(userId, backup.id, '__deleted__');
      this.proposals.markApplied(userId, proposal.id, backup.id);
      return {
        proposal: toPublicProposal(proposal),
        backupId: backup.id,
        path: proposal.path,
        action: proposal.action,
      };
    });
  }

  reject(userId: string, proposalId: string): PublicProposal {
    const proposal = this.proposals.reject(userId, proposalId);
    if (!proposal) {
      throw new AppError(404, 'PROPOSAL_NOT_FOUND', 'La propuesta no existe o caducó.');
    }
    return toPublicProposal(proposal);
  }

  list(userId: string): PublicProposal[] {
    return this.proposals.list(userId);
  }

  cacheStats(userId: string): { entries: number; bytes: number } {
    return this.proposals.statsForUser(userId);
  }

  clearCache(userId: string): number {
    return this.proposals.clearForUser(userId);
  }

  async restore(
    userId: string,
    backupId: string,
    force: boolean,
  ): Promise<{ path: string; restoredAt: number; forced: boolean }> {
    const backup = this.store.findBackup(userId, backupId);
    if (!backup) {
      throw new AppError(404, 'BACKUP_NOT_FOUND', 'El backup no existe o ya se eliminó.');
    }
    if (backup.restoredAt) {
      throw new AppError(409, 'ALREADY_RESTORED', 'Este backup ya se restauró.');
    }
    const project = this.store.findProject(userId, backup.projectId);
    if (!project) {
      throw new AppError(404, 'PROJECT_NOT_FOUND', 'El proyecto ya no está registrado.');
    }

    return this.#withLock(`${backup.projectId}:${backup.path}`, async () => {
      const currentHash = await this.sandbox.hashFile(project.rootPath, backup.path);
      const expectedPostHash = backup.postHash === '__deleted__' ? null : backup.postHash;
      if (backup.postHash && currentHash !== expectedPostHash && !force) {
        throw new AppError(
          409,
          'BACKUP_CONFLICT',
          'El archivo cambió después de aplicar la propuesta. Confirma que quieres sobrescribirlo.',
          { details: { requiresForce: true } },
        );
      }

      if (backup.existed) {
        const content = await this.backups.content(backup);
        await this.sandbox.writeFileAtomic({
          projectRoot: project.rootPath,
          path: backup.path,
          content,
          expectedHash: currentHash,
          maxBytes: Math.max(this.config.maxFileBytes * 4, 1_048_576),
        });
      } else if (currentHash !== null) {
        await this.sandbox.deleteFile({
          projectRoot: project.rootPath,
          path: backup.path,
          expectedHash: currentHash,
        });
      }
      const now = Date.now();
      this.store.markBackupRestored(userId, backup.id, now);
      return { path: backup.path, restoredAt: now, forced: force };
    });
  }

  listBackups(userId: string) {
    return this.store.listBackups(userId).map((backup) => ({
      id: backup.id,
      projectId: backup.projectId,
      path: backup.path,
      createdAt: backup.createdAt,
      expiresAt: backup.expiresAt,
      restoredAt: backup.restoredAt,
      existed: backup.existed,
    }));
  }

  estimateContextTokens(content: string): number {
    return estimateTokens(content);
  }

  #locks = new Map<string, Promise<unknown>>();

  async #withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => gate);
    this.#locks.set(key, chained);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.#locks.get(key) === chained) {
        this.#locks.delete(key);
      }
    }
  }
}
