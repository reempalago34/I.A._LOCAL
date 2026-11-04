export type UserRole = 'admin' | 'user';

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  createdAt: number;
  updatedAt: number;
}

export interface Project {
  id: string;
  userId: string;
  name: string;
  rootPath: string;
  createdAt: number;
  updatedAt: number;
}

export interface Conversation {
  id: string;
  userId: string;
  projectId: string | null;
  title: string;
  model: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount?: number;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  model: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

export interface Settings {
  runtimeUrl: string;
  defaultModel: string;
  persistHistory: boolean;
  language: 'es' | 'en';
  theme: 'system' | 'light' | 'dark';
  maxFileBytes: number;
  maxContextBytes: number;
  maxContextFiles: number;
  maxStorageBytes: number;
  excludePatterns: string[];
}

export interface ServerInfo {
  deploymentMode: 'local' | 'server';
  allowCustomRuntime: boolean;
  defaultRuntimeUrl: string;
  registrationEnabled: boolean;
  commandExecutionEnabled: boolean;
  runtimeNumCtx: number;
  telemetryEnabled: boolean;
  limits: {
    maxFileBytes: number;
    maxContextBytes: number;
    maxContextFiles: number;
    maxMessageChars: number;
    maxStorageBytes: number;
  };
}

export interface StorageInfo {
  conversationsPersisted: boolean;
  backupsRetentionDays: number;
  telemetry: string;
  note: string;
}

export interface SettingsResponse {
  settings: Settings;
  server: ServerInfo;
  storage: StorageInfo;
}

export interface AuthConfig {
  registrationEnabled: boolean;
  deploymentMode: 'local' | 'server';
  commandExecutionEnabled: boolean;
  telemetry: boolean;
}

export interface ModelRequirements {
  diskBytes: number;
  estimatedRamBytes: number | null;
  estimateQuality: 'rough' | 'unknown';
  notes: string[];
}

export interface RuntimeModel {
  name: string;
  sizeBytes: number;
  digest?: string;
  modifiedAt?: string;
  details: {
    format?: string;
    family?: string;
    families?: string[];
    parameterSize?: string;
    quantizationLevel?: string;
  };
  capabilities: {
    contextLength?: number;
    parameterCount?: number;
    embeddingLength?: number;
    capabilities?: string[];
  };
  requirements: ModelRequirements;
}

export interface RuntimeStatus {
  reachable: boolean;
  version?: string;
  modelCount?: number;
  error?: { code: string; message: string };
  runtime?: RuntimeInfo;
}

export type ExecutionScope = 'this-computer' | 'remote-server';

export interface RuntimeInfo {
  host: string;
  location: 'local' | 'private' | 'remote';
  isLocal: boolean;
  executionScope?: ExecutionScope;
}

export interface StorageUsage {
  conversations: { count: number; messages: number; bytes: number };
  backups: { count: number; bytes: number };
  temporary: { bytes: number };
  cache: { entries: number; bytes: number };
  database: { bytes: number };
  dataDir: { usedBytes: number; freeBytes: number; totalBytes: number };
  trackedBytes: number;
  limitBytes: number;
  serverLimitBytes: number;
  overLimit: boolean;
}

export interface StorageResponse {
  usage: StorageUsage;
  note: string;
}

export type PreflightLevel = 'ok' | 'warning' | 'blocked';

export interface PreflightCheck {
  id: string;
  level: PreflightLevel;
  message: string;
}

export interface SystemResources {
  host: {
    platform: string;
    arch: string;
    release: string;
    cpuModel: string;
    cpuCount: number;
    totalMemoryBytes: number;
    freeMemoryBytes: number;
    loadAverage: number[];
    uptimeSeconds: number;
  };
  storage: {
    dataDir: { usedBytes: number; freeBytes: number; totalBytes: number };
    projectsRoot: { usedBytes: number; freeBytes: number; totalBytes: number };
  };
  runtime: {
    url: string;
    host: string;
    location: 'local' | 'private' | 'remote';
    executionScope: ExecutionScope;
    reachable: boolean;
    version?: string;
    loadedModels: {
      name: string;
      sizeBytes: number;
      sizeVramBytes: number;
      contextLength?: number;
      expiresAt?: string;
    }[];
    gpuActive: boolean;
    error?: { code: string; message: string };
  };
  model: RuntimeModel | null;
  checks: PreflightCheck[];
  warnings: string[];
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'blocked';
  size?: number;
  blocked?: boolean;
  reason?: string;
}

export interface DirectoryListing {
  path: string;
  entries: FileEntry[];
  truncated: boolean;
}

export interface ContextFile {
  path: string;
  content: string;
  bytes: number;
  lines: number;
  sha256: string;
  selected?: boolean;
}

export interface ContextPreview {
  files: ContextFile[];
  errors: { path: string; code: string; message: string }[];
  totalBytes: number;
  totalLines: number;
  estimatedTokens: number;
  maxContextBytes: number;
  maxFileBytes: number;
  maxContextFiles: number;
  formatted: string;
  truncated: boolean;
  project?: { id: string; name: string };
  disclaimer?: string;
}

export interface DiffStats {
  additions: number;
  deletions: number;
  hunks: number;
}

export interface Proposal {
  id: string;
  projectId: string;
  path: string;
  action: 'write' | 'delete';
  diff: string;
  stats: DiffStats;
  sensitive: boolean;
  sensitiveReason?: string;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'applied' | 'rejected';
  backupId?: string;
}

export interface CommandInfo {
  command: string;
  allowed: boolean;
  enabled: boolean;
  reason?: string;
  effects: string;
  argv?: string[];
  cwd?: string;
  executesScripts: boolean;
}

export interface CommandResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface Backup {
  id: string;
  projectId: string;
  path: string;
  createdAt: number;
  expiresAt: number;
  restoredAt: number | null;
  existed: boolean;
}

export interface PrivacyInfo {
  conversations: number;
  messages: number;
  backups: number;
  backupRetentionDays: number;
  historyEnabled: boolean;
  telemetry: boolean;
  note: string;
}

export interface ChatMeta {
  generationId: string;
  conversationId: string | null;
  userMessageId: string | null;
  model: string;
  runtime: RuntimeInfo;
  context: {
    files: { path: string; bytes: number }[];
    totalBytes: number;
    estimatedTokens: number;
  } | null;
  persisted: boolean;
}

export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalDurationMs?: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  model?: string | null;
  streaming?: boolean;
  executionLocation?: 'local' | 'private' | 'remote';
  meta?: ChatMeta;
  proposals?: Proposal[];
  commands?: CommandInfo[];
  warnings?: string[];
  usage?: ChatUsage;
  error?: ApiErrorShape;
  persisted?: boolean;
}

export interface ApiErrorShape {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  requestId?: string;
}

export interface WorkspaceSelection {
  projectId: string | null;
  paths: string[];
}
