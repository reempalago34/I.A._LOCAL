import { randomUUID } from 'node:crypto';
import type { DiffStats } from './diff.js';

export interface StoredProposal {
  id: string;
  userId: string;
  projectId: string;
  path: string;
  action: 'write' | 'delete';
  oldContent: string | null;
  newContent: string | null;
  oldHash: string | null;
  oldMode: number;
  diff: string;
  stats: DiffStats;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'applied' | 'rejected';
  backupId?: string;
}

export interface PublicProposal {
  id: string;
  projectId: string;
  path: string;
  action: 'write' | 'delete';
  diff: string;
  stats: DiffStats;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'applied' | 'rejected';
  backupId?: string;
}

export class ProposalStore {
  #items = new Map<string, StoredProposal>();
  #maxItems = 1_000;

  constructor(private readonly ttlMs: number) {}

  create(input: Omit<StoredProposal, 'id' | 'createdAt' | 'expiresAt' | 'status'>): StoredProposal {
    const now = Date.now();
    const proposal: StoredProposal = {
      ...input,
      id: randomUUID(),
      createdAt: now,
      expiresAt: now + this.ttlMs,
      status: 'pending',
    };
    this.#items.set(proposal.id, proposal);
    this.#enforceLimit();
    return proposal;
  }

  get(userId: string, id: string): StoredProposal | null {
    const item = this.#items.get(id);
    if (!item || item.userId !== userId) return null;
    if (item.expiresAt <= Date.now()) {
      this.#items.delete(id);
      return null;
    }
    return item;
  }

  list(userId: string): PublicProposal[] {
    this.cleanup();
    return [...this.#items.values()]
      .filter((item) => item.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(toPublicProposal);
  }

  markApplied(userId: string, id: string, backupId: string): void {
    const item = this.get(userId, id);
    if (!item) return;
    item.status = 'applied';
    item.backupId = backupId;
  }

  reject(userId: string, id: string): StoredProposal | null {
    const item = this.get(userId, id);
    if (!item) return null;
    item.status = 'rejected';
    this.#items.delete(id);
    return item;
  }

  clearForUser(userId: string): number {
    let removed = 0;
    for (const [id, item] of this.#items) {
      if (item.userId !== userId) continue;
      this.#items.delete(id);
      removed += 1;
    }
    return removed;
  }

  statsForUser(userId: string): { entries: number; bytes: number } {
    let entries = 0;
    let bytes = 0;
    for (const item of this.#items.values()) {
      if (item.userId !== userId) continue;
      entries += 1;
      bytes += Buffer.byteLength(item.oldContent ?? '', 'utf8');
      bytes += Buffer.byteLength(item.newContent ?? '', 'utf8');
      bytes += Buffer.byteLength(item.diff, 'utf8');
    }
    return { entries, bytes };
  }

  cleanup(): void {
    const now = Date.now();
    for (const [id, item] of this.#items) {
      if (item.expiresAt <= now) this.#items.delete(id);
    }
  }

  #enforceLimit(): void {
    if (this.#items.size <= this.#maxItems) return;
    const sorted = [...this.#items.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const item of sorted.slice(0, this.#items.size - this.#maxItems)) {
      this.#items.delete(item.id);
    }
  }
}

export function toPublicProposal(proposal: StoredProposal): PublicProposal {
  return {
    id: proposal.id,
    projectId: proposal.projectId,
    path: proposal.path,
    action: proposal.action,
    diff: proposal.diff,
    stats: proposal.stats,
    createdAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
    status: proposal.status,
    ...(proposal.backupId ? { backupId: proposal.backupId } : {}),
  };
}
