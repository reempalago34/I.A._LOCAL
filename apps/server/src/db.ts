import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type {
  BackupRecord,
  ConversationRecord,
  MessageRecord,
  MessageRole,
  ProjectRecord,
  SessionRecord,
  SettingsData,
  UserRecord,
  UserRole,
} from './types.js';

export interface SessionWithUser {
  session: SessionRecord;
  user: UserRecord;
}

const SCHEMA_VERSION = 1;

export function openDatabase(databasePath: string): Database.Database {
  if (databasePath !== ':memory:') {
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    try {
      chmodSync(path.dirname(databasePath), 0o700);
    } catch {
      // En algunos sistemas de archivos (volúmenes gestionados) no se puede cambiar.
    }
  }
  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (databasePath === ':memory:') {
    db.pragma('journal_mode = MEMORY');
  } else {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version >= SCHEMA_VERSION) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      ip_hash TEXT,
      user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS settings (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (user_id, root_path)
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      model TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      model TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

    CREATE TABLE IF NOT EXISTS login_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_key TEXT NOT NULL,
      attempted_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_login_attempts_key ON login_attempts(attempt_key, attempted_at);

    CREATE TABLE IF NOT EXISTS backups (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      restored_at INTEGER,
      existed INTEGER NOT NULL,
      mode INTEGER NOT NULL DEFAULT 420,
      post_hash TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_backups_user ON backups(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_backups_expires ON backups(expires_at);

    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
}

export class Store {
  constructor(readonly db: Database.Database) {}

  close(): void {
    this.db.close();
  }

  ping(): void {
    this.db.prepare('SELECT 1').get();
  }

  // Users --------------------------------------------------------------
  countUsers(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
    return row.count;
  }

  findUserByEmail(email: string): UserRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, email, display_name AS displayName, password_hash AS passwordHash,
                role, created_at AS createdAt, updated_at AS updatedAt
         FROM users WHERE email = ? COLLATE NOCASE`,
      )
      .get(email) as UserRecord | undefined;
    return row ?? null;
  }

  findUserById(id: string): UserRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, email, display_name AS displayName, password_hash AS passwordHash,
                role, created_at AS createdAt, updated_at AS updatedAt
         FROM users WHERE id = ?`,
      )
      .get(id) as UserRecord | undefined;
    return row ?? null;
  }

  createUser(input: {
    id: string;
    email: string;
    displayName: string;
    passwordHash: string;
    role: UserRole;
    now: number;
  }): UserRecord {
    this.db
      .prepare(
        `INSERT INTO users (id, email, display_name, password_hash, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.email,
        input.displayName,
        input.passwordHash,
        input.role,
        input.now,
        input.now,
      );
    return this.findUserById(input.id)!;
  }

  updateUserPassword(userId: string, passwordHash: string, now: number): void {
    this.db
      .prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(passwordHash, now, userId);
  }

  listUsers(): UserRecord[] {
    return this.db
      .prepare(
        `SELECT id, email, display_name AS displayName, password_hash AS passwordHash,
                role, created_at AS createdAt, updated_at AS updatedAt
         FROM users ORDER BY email`,
      )
      .all() as UserRecord[];
  }

  // Sessions -----------------------------------------------------------
  createSession(input: SessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, user_id, csrf_token, created_at, expires_at, last_seen_at, ip_hash, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.userId,
        input.csrfToken,
        input.createdAt,
        input.expiresAt,
        input.lastSeenAt,
        input.ipHash,
        input.userAgent,
      );
  }

  findSessionWithUser(sessionHash: string): SessionWithUser | null {
    const row = this.db
      .prepare(
        `SELECT s.id AS sessionId, s.user_id AS sessionUserId, s.csrf_token AS csrfToken,
                s.created_at AS sessionCreatedAt, s.expires_at AS expiresAt,
                s.last_seen_at AS lastSeenAt, s.ip_hash AS ipHash, s.user_agent AS userAgent,
                u.id, u.email, u.display_name AS displayName, u.password_hash AS passwordHash,
                u.role, u.created_at AS createdAt, u.updated_at AS updatedAt
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id = ?`,
      )
      .get(sessionHash) as
      | (UserRecord & {
          sessionId: string;
          sessionUserId: string;
          csrfToken: string;
          sessionCreatedAt: number;
          expiresAt: number;
          lastSeenAt: number;
          ipHash: string | null;
          userAgent: string | null;
        })
      | undefined;
    if (!row) return null;
    const {
      sessionId,
      sessionUserId,
      csrfToken,
      sessionCreatedAt,
      expiresAt,
      lastSeenAt,
      ipHash,
      userAgent,
      ...user
    } = row;
    return {
      session: {
        id: sessionId,
        userId: sessionUserId,
        csrfToken,
        createdAt: sessionCreatedAt,
        expiresAt,
        lastSeenAt,
        ipHash,
        userAgent,
      },
      user: user as UserRecord,
    };
  }

  touchSession(sessionId: string, lastSeenAt: number): void {
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(lastSeenAt, sessionId);
  }

  deleteSession(sessionId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }

  deleteOtherSessions(userId: string, keepSessionId?: string): void {
    if (keepSessionId) {
      this.db
        .prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?')
        .run(userId, keepSessionId);
    } else {
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    }
  }

  deleteExpiredSessions(now: number): number {
    return this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now).changes;
  }

  // Login attempts -----------------------------------------------------
  countRecentLoginAttempts(key: string, since: number): number {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS count FROM login_attempts WHERE attempt_key = ? AND attempted_at >= ?',
      )
      .get(key, since) as { count: number };
    return row.count;
  }

  recordLoginAttempt(key: string, now: number): void {
    this.db
      .prepare('INSERT INTO login_attempts (attempt_key, attempted_at) VALUES (?, ?)')
      .run(key, now);
  }

  clearLoginAttempts(key: string): void {
    this.db.prepare('DELETE FROM login_attempts WHERE attempt_key = ?').run(key);
  }

  cleanupLoginAttempts(before: number): number {
    return this.db.prepare('DELETE FROM login_attempts WHERE attempted_at < ?').run(before).changes;
  }

  // Settings -----------------------------------------------------------
  getSettings(userId: string): SettingsData | null {
    const row = this.db.prepare('SELECT data FROM settings WHERE user_id = ?').get(userId) as
      | { data: string }
      | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.data) as SettingsData;
    } catch {
      return null;
    }
  }

  saveSettings(userId: string, data: SettingsData, now: number): void {
    this.db
      .prepare(
        `INSERT INTO settings (user_id, data, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(userId, JSON.stringify(data), now);
  }

  // Projects -----------------------------------------------------------
  listProjects(userId: string): ProjectRecord[] {
    return this.db
      .prepare(
        `SELECT id, user_id AS userId, name, root_path AS rootPath,
                created_at AS createdAt, updated_at AS updatedAt
         FROM projects WHERE user_id = ? ORDER BY name COLLATE NOCASE`,
      )
      .all(userId) as ProjectRecord[];
  }

  findProject(userId: string, projectId: string): ProjectRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, user_id AS userId, name, root_path AS rootPath,
                created_at AS createdAt, updated_at AS updatedAt
         FROM projects WHERE id = ? AND user_id = ?`,
      )
      .get(projectId, userId) as ProjectRecord | undefined;
    return row ?? null;
  }

  findProjectByPath(userId: string, rootPath: string): ProjectRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, user_id AS userId, name, root_path AS rootPath,
                created_at AS createdAt, updated_at AS updatedAt
         FROM projects WHERE user_id = ? AND root_path = ?`,
      )
      .get(userId, rootPath) as ProjectRecord | undefined;
    return row ?? null;
  }

  createProject(input: {
    id: string;
    userId: string;
    name: string;
    rootPath: string;
    now: number;
  }): ProjectRecord {
    this.db
      .prepare(
        `INSERT INTO projects (id, user_id, name, root_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.userId, input.name, input.rootPath, input.now, input.now);
    return this.findProject(input.userId, input.id)!;
  }

  touchProject(projectId: string, now: number): void {
    this.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, projectId);
  }

  deleteProject(userId: string, projectId: string): boolean {
    return (
      this.db.prepare('DELETE FROM projects WHERE id = ? AND user_id = ?').run(projectId, userId)
        .changes > 0
    );
  }

  // Conversations ------------------------------------------------------
  listConversations(userId: string): ConversationRecord[] {
    return this.db
      .prepare(
        `SELECT id, user_id AS userId, project_id AS projectId, title, model,
                created_at AS createdAt, updated_at AS updatedAt
         FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 200`,
      )
      .all(userId) as ConversationRecord[];
  }

  findConversation(userId: string, conversationId: string): ConversationRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, user_id AS userId, project_id AS projectId, title, model,
                created_at AS createdAt, updated_at AS updatedAt
         FROM conversations WHERE id = ? AND user_id = ?`,
      )
      .get(conversationId, userId) as ConversationRecord | undefined;
    return row ?? null;
  }

  createConversation(input: {
    id: string;
    userId: string;
    projectId: string | null;
    title: string;
    model: string | null;
    now: number;
  }): ConversationRecord {
    this.db
      .prepare(
        `INSERT INTO conversations (id, user_id, project_id, title, model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.userId, input.projectId, input.title, input.model, input.now, input.now);
    return this.findConversation(input.userId, input.id)!;
  }

  updateConversation(
    userId: string,
    conversationId: string,
    patch: { title?: string; projectId?: string | null; model?: string | null },
    now: number,
  ): ConversationRecord | null {
    const current = this.findConversation(userId, conversationId);
    if (!current) return null;
    this.db
      .prepare(
        `UPDATE conversations SET title = ?, project_id = ?, model = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`,
      )
      .run(
        patch.title ?? current.title,
        patch.projectId === undefined ? current.projectId : patch.projectId,
        patch.model === undefined ? current.model : patch.model,
        now,
        conversationId,
        userId,
      );
    return this.findConversation(userId, conversationId);
  }

  deleteConversation(userId: string, conversationId: string): boolean {
    return (
      this.db
        .prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?')
        .run(conversationId, userId).changes > 0
    );
  }

  deleteAllConversations(userId: string): number {
    return this.db.prepare('DELETE FROM conversations WHERE user_id = ?').run(userId).changes;
  }

  listMessages(conversationId: string, limit = 100): MessageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, conversation_id AS conversationId, role, content, model, metadata,
                created_at AS createdAt
         FROM messages WHERE conversation_id = ?
         ORDER BY created_at ASC, rowid ASC LIMIT ?`,
      )
      .all(conversationId, limit) as (Omit<MessageRecord, 'metadata'> & {
      metadata: string | null;
    })[];
    return rows.map((row) => ({
      ...row,
      metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
    }));
  }

  listRecentMessages(conversationId: string, limit = 40): MessageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, conversation_id AS conversationId, role, content, model, metadata,
                created_at AS createdAt
         FROM messages WHERE conversation_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(conversationId, limit) as (Omit<MessageRecord, 'metadata'> & {
      metadata: string | null;
    })[];
    return rows.reverse().map((row) => ({
      ...row,
      metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
    }));
  }

  countMessages(conversationId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?')
      .get(conversationId) as { count: number };
    return row.count;
  }

  storageStats(userId: string): {
    conversations: number;
    conversationBytes: number;
    messages: number;
    messageBytes: number;
    metadataBytes: number;
  } {
    const conversationRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(title)), 0) AS bytes
         FROM conversations WHERE user_id = ?`,
      )
      .get(userId) as { count: number; bytes: number };
    const messageRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(LENGTH(content)), 0) AS contentBytes,
                COALESCE(SUM(LENGTH(COALESCE(metadata, ''))), 0) AS metadataBytes
         FROM messages
         WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)`,
      )
      .get(userId) as { count: number; contentBytes: number; metadataBytes: number };
    return {
      conversations: conversationRow.count,
      conversationBytes: conversationRow.bytes,
      messages: messageRow.count,
      messageBytes: messageRow.contentBytes,
      metadataBytes: messageRow.metadataBytes,
    };
  }

  createMessage(input: {
    id: string;
    conversationId: string;
    role: MessageRole;
    content: string;
    model: string | null;
    metadata?: Record<string, unknown> | null;
    now: number;
  }): MessageRecord {
    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content, model, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.conversationId,
        input.role,
        input.content,
        input.model,
        input.metadata ? JSON.stringify(input.metadata) : null,
        input.now,
      );
    return {
      id: input.id,
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      model: input.model,
      metadata: input.metadata ?? null,
      createdAt: input.now,
    };
  }

  // Backups ------------------------------------------------------------
  createBackup(input: BackupRecord): void {
    this.db
      .prepare(
        `INSERT INTO backups (id, user_id, project_id, path, created_at, expires_at, restored_at, existed, mode, post_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.userId,
        input.projectId,
        input.path,
        input.createdAt,
        input.expiresAt,
        input.restoredAt,
        input.existed ? 1 : 0,
        input.mode,
        input.postHash,
      );
  }

  findBackup(userId: string, backupId: string): BackupRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, user_id AS userId, project_id AS projectId, path,
                created_at AS createdAt, expires_at AS expiresAt, restored_at AS restoredAt,
                existed, mode, post_hash AS postHash
         FROM backups WHERE id = ? AND user_id = ?`,
      )
      .get(backupId, userId) as (Omit<BackupRecord, 'existed'> & { existed: number }) | undefined;
    if (!row) return null;
    return { ...row, existed: row.existed === 1 };
  }

  listBackups(userId: string): BackupRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, user_id AS userId, project_id AS projectId, path,
                created_at AS createdAt, expires_at AS expiresAt, restored_at AS restoredAt,
                existed, mode, post_hash AS postHash
         FROM backups WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`,
      )
      .all(userId) as (Omit<BackupRecord, 'existed'> & { existed: number })[];
    return rows.map((row) => ({ ...row, existed: row.existed === 1 }));
  }

  markBackupRestored(userId: string, backupId: string, now: number): void {
    this.db
      .prepare('UPDATE backups SET restored_at = ? WHERE id = ? AND user_id = ?')
      .run(now, backupId, userId);
  }

  deleteBackup(userId: string, backupId: string): boolean {
    return (
      this.db.prepare('DELETE FROM backups WHERE id = ? AND user_id = ?').run(backupId, userId)
        .changes > 0
    );
  }

  listAllBackupsForUser(userId: string): BackupRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, user_id AS userId, project_id AS projectId, path,
                created_at AS createdAt, expires_at AS expiresAt, restored_at AS restoredAt,
                existed, mode, post_hash AS postHash
         FROM backups WHERE user_id = ?`,
      )
      .all(userId) as (Omit<BackupRecord, 'existed'> & { existed: number })[];
    return rows.map((row) => ({ ...row, existed: row.existed === 1 }));
  }

  listBackupsForProject(userId: string, projectId: string): BackupRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, user_id AS userId, project_id AS projectId, path,
                created_at AS createdAt, expires_at AS expiresAt, restored_at AS restoredAt,
                existed, mode, post_hash AS postHash
         FROM backups WHERE user_id = ? AND project_id = ?`,
      )
      .all(userId, projectId) as (Omit<BackupRecord, 'existed'> & { existed: number })[];
    return rows.map((row) => ({ ...row, existed: row.existed === 1 }));
  }

  deleteBackupsForProject(userId: string, projectId: string): number {
    return this.db
      .prepare('DELETE FROM backups WHERE user_id = ? AND project_id = ?')
      .run(userId, projectId).changes;
  }

  setBackupPostHash(userId: string, backupId: string, postHash: string): void {
    this.db
      .prepare('UPDATE backups SET post_hash = ? WHERE id = ? AND user_id = ?')
      .run(postHash, backupId, userId);
  }

  findExpiredBackups(now: number): BackupRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, user_id AS userId, project_id AS projectId, path,
                created_at AS createdAt, expires_at AS expiresAt, restored_at AS restoredAt,
                existed, mode, post_hash AS postHash
         FROM backups WHERE expires_at <= ?`,
      )
      .all(now) as (Omit<BackupRecord, 'existed'> & { existed: number })[];
    return rows.map((row) => ({ ...row, existed: row.existed === 1 }));
  }

  deleteExpiredBackups(now: number): number {
    return this.db.prepare('DELETE FROM backups WHERE expires_at <= ?').run(now).changes;
  }

  deleteAllBackups(userId: string): BackupRecord[] {
    const backups = this.listAllBackupsForUser(userId);
    this.db.prepare('DELETE FROM backups WHERE user_id = ?').run(userId);
    return backups;
  }
}
