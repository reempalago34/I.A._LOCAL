export type UserRole = 'admin' | 'user';

export interface UserRecord {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  role: UserRole;
  createdAt: number;
  updatedAt: number;
}

export type PublicUser = Omit<UserRecord, 'passwordHash'>;

export interface SessionRecord {
  id: string;
  userId: string;
  csrfToken: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  ipHash: string | null;
  userAgent: string | null;
}

export interface AuthenticatedSession {
  session: SessionRecord;
  user: UserRecord;
}

export interface ProjectRecord {
  id: string;
  userId: string;
  name: string;
  rootPath: string;
  createdAt: number;
  updatedAt: number;
}

export type MessageRole = 'user' | 'assistant';

export interface ConversationRecord {
  id: string;
  userId: string;
  projectId: string | null;
  title: string;
  model: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  model: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

export interface SettingsData {
  runtimeUrl: string;
  defaultModel: string;
  persistHistory: boolean;
  language: 'es' | 'en';
  theme: 'system' | 'light' | 'dark';
  maxFileBytes: number;
  maxContextBytes: number;
  maxContextFiles: number;
  /** Límite de datos persistidos por usuario: conversaciones + backups. */
  maxStorageBytes: number;
  excludePatterns: string[];
}

export interface BackupRecord {
  id: string;
  userId: string;
  projectId: string;
  path: string;
  createdAt: number;
  expiresAt: number;
  restoredAt: number | null;
  existed: boolean;
  mode: number;
  postHash: string | null;
}
