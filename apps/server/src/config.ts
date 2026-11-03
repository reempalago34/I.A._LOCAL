import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv({ path: ['.env', '../../.env'], quiet: true });

const booleanish = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((value) => value === 'true' || value === '1' || value === 'yes');

const optionalBoolean = booleanish.optional().transform((value) => value ?? false);

const booleanDefaultTrue = booleanish.optional().transform((value) => value ?? true);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).max(255).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATA_DIR: z.string().min(1).max(4096).default('data'),
  PROJECTS_ROOT: z.string().min(1).max(4096).optional(),
  WEB_DIST: z.string().min(1).max(4096).optional(),
  PUBLIC_ORIGIN: z.string().url().optional(),
  TRUST_PROXY: optionalBoolean,
  COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),
  SESSION_SECRET: z.string().min(32).max(512).optional(),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(168),
  SESSION_IDLE_HOURS: z.coerce.number().int().min(1).max(720).default(48),
  ALLOW_REGISTRATION: optionalBoolean,
  DEPLOYMENT_MODE: z.enum(['local', 'server']).default('local'),
  OLLAMA_BASE_URL: z.string().url().default('http://127.0.0.1:11434'),
  OLLAMA_AUTH_TOKEN: z.string().max(2048).optional(),
  ALLOW_CUSTOM_RUNTIME: booleanDefaultTrue,
  RUNTIME_ALLOWED_HOSTS: z.string().max(2048).optional(),
  RUNTIME_ALLOWED_PORTS: z.string().max(512).optional(),
  RUNTIME_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
  RUNTIME_STREAM_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(900_000).default(120_000),
  MAX_REQUEST_BYTES: z.coerce.number().int().min(16_384).max(8_388_608).default(1_048_576),
  MAX_MESSAGE_CHARS: z.coerce.number().int().min(1_000).max(200_000).default(20_000),
  // Valores pensados para un cliente ligero: 128 KiB por archivo y 256 KiB por
  // consulta. Se pueden elevar por entorno, pero cada byte adicional se mantiene
  // en memoria del navegador/servidor al enviar contexto.
  MAX_FILE_BYTES: z.coerce.number().int().min(1_024).max(2_097_152).default(131_072),
  MAX_CONTEXT_BYTES: z.coerce.number().int().min(1_024).max(4_194_304).default(262_144),
  MAX_CONTEXT_FILES: z.coerce.number().int().min(1).max(30).default(8),
  // Por defecto 64 MiB para el equipo ligero; configurable y revisable desde ajustes
  MAX_STORAGE_BYTES: z.coerce.number().int().min(1_048_576).max(10_737_418_240).default(67_108_864),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(20).default(5),
  LOGIN_WINDOW_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  LOGIN_BASE_DELAY_MS: z.coerce.number().int().min(0).max(10_000).default(250),
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).max(10_000).default(120),
  CHAT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(120).default(20),
  ENABLE_COMMAND_EXECUTION: optionalBoolean,
  COMMAND_ALLOWLIST: z.string().max(2048).default('git,node,npm,npx'),
  COMMAND_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  COMMAND_MAX_OUTPUT_BYTES: z.coerce.number().int().min(1_024).max(1_048_576).default(65_536),
  BACKUP_RETENTION_DAYS: z.coerce.number().int().min(0).max(365).default(7),
  PROPOSAL_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(120),
});

export type AppConfig = ReturnType<typeof buildConfig>;

export type CookieSecureMode = 'auto' | 'true' | 'false';

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export function resolveWebDist(cwd: string, override?: string): string {
  if (override) return path.resolve(cwd, override);
  const candidates = [
    path.resolve(cwd, 'apps/web/dist'),
    path.resolve(cwd, '../web/dist'),
    path.resolve(cwd, 'web/dist'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

export function loadConfig(options: LoadConfigOptions = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Configuración inválida (variables de entorno): ${details}`);
  }
  const value = parsed.data;
  const isProduction = value.NODE_ENV === 'production';
  const dataDir = path.resolve(cwd, value.DATA_DIR);
  const projectsRoot = path.resolve(
    cwd,
    value.PROJECTS_ROOT ?? path.join(os.homedir(), 'ForgeProjects'),
  );
  const webDist = resolveWebDist(cwd, value.WEB_DIST);

  if (isProduction && !value.SESSION_SECRET) {
    throw new Error(
      'SESSION_SECRET es obligatorio en producción (mínimo 32 caracteres). Configúralo como secreto en Coolify.',
    );
  }
  if (isProduction && value.SESSION_SECRET === 'change-me-to-a-long-random-value-32chars') {
    throw new Error('SESSION_SECRET no puede ser el valor de ejemplo. Genera uno aleatorio.');
  }

  const defaultRuntimeUrl = new URL(value.OLLAMA_BASE_URL);
  const allowedHosts = new Set<string>([
    defaultRuntimeUrl.hostname.toLowerCase(),
    'localhost',
    '127.0.0.1',
    '::1',
  ]);
  for (const host of (value.RUNTIME_ALLOWED_HOSTS ?? '').split(',')) {
    const trimmed = host.trim().toLowerCase();
    if (trimmed) allowedHosts.add(trimmed);
  }
  const allowedPorts = new Set<number>([
    Number(defaultRuntimeUrl.port || (defaultRuntimeUrl.protocol === 'https:' ? 443 : 80)),
    11434,
  ]);
  for (const port of (value.RUNTIME_ALLOWED_PORTS ?? '').split(',')) {
    const parsedPort = Number(port.trim());
    if (Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort < 65536) {
      allowedPorts.add(parsedPort);
    }
  }

  return buildConfig({
    ...value,
    isProduction,
    cwd,
    dataDir,
    projectsRoot,
    webDist,
    sessionSecret: value.SESSION_SECRET ?? randomSecret(),
    generatedSessionSecret: !value.SESSION_SECRET,
    defaultRuntimeUrl: normalizeRuntimeUrl(value.OLLAMA_BASE_URL),
    runtimeAuthToken: value.OLLAMA_AUTH_TOKEN,
    runtimeAllowedHosts: allowedHosts,
    runtimeAllowedPorts: allowedPorts,
    commandAllowlist: value.COMMAND_ALLOWLIST.split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  });
}

function buildConfig(input: {
  NODE_ENV: 'development' | 'test' | 'production';
  HOST: string;
  PORT: number;
  LOG_LEVEL: string;
  DATA_DIR: string;
  PROJECTS_ROOT?: string;
  WEB_DIST?: string;
  PUBLIC_ORIGIN?: string;
  TRUST_PROXY: boolean;
  COOKIE_SECURE: CookieSecureMode;
  sessionSecret: string;
  generatedSessionSecret: boolean;
  SESSION_TTL_HOURS: number;
  SESSION_IDLE_HOURS: number;
  ALLOW_REGISTRATION: boolean;
  DEPLOYMENT_MODE: 'local' | 'server';
  defaultRuntimeUrl: string;
  runtimeAuthToken?: string;
  ALLOW_CUSTOM_RUNTIME: boolean;
  runtimeAllowedHosts: Set<string>;
  runtimeAllowedPorts: Set<number>;
  RUNTIME_TIMEOUT_MS: number;
  RUNTIME_STREAM_IDLE_TIMEOUT_MS: number;
  MAX_REQUEST_BYTES: number;
  MAX_MESSAGE_CHARS: number;
  MAX_FILE_BYTES: number;
  MAX_CONTEXT_BYTES: number;
  MAX_CONTEXT_FILES: number;
  MAX_STORAGE_BYTES: number;
  LOGIN_MAX_ATTEMPTS: number;
  LOGIN_WINDOW_MINUTES: number;
  LOGIN_BASE_DELAY_MS: number;
  API_RATE_LIMIT_PER_MINUTE: number;
  CHAT_RATE_LIMIT_PER_MINUTE: number;
  ENABLE_COMMAND_EXECUTION: boolean;
  commandAllowlist: string[];
  COMMAND_TIMEOUT_MS: number;
  COMMAND_MAX_OUTPUT_BYTES: number;
  BACKUP_RETENTION_DAYS: number;
  PROPOSAL_TTL_MINUTES: number;
  isProduction: boolean;
  cwd: string;
  dataDir: string;
  projectsRoot: string;
  webDist: string;
}) {
  return {
    env: input.NODE_ENV,
    isProduction: input.isProduction,
    host: input.HOST,
    port: input.PORT,
    logLevel: input.LOG_LEVEL,
    cwd: input.cwd,
    dataDir: input.dataDir,
    databasePath: path.join(input.dataDir, 'forge.sqlite'),
    projectsRoot: input.projectsRoot,
    webDist: input.webDist,
    publicOrigin: input.PUBLIC_ORIGIN?.replace(/\/$/, ''),
    trustProxy: input.TRUST_PROXY,
    cookieSecure: input.COOKIE_SECURE,
    sessionSecret: input.sessionSecret,
    generatedSessionSecret: input.generatedSessionSecret,
    sessionTtlHours: input.SESSION_TTL_HOURS,
    sessionIdleHours: input.SESSION_IDLE_HOURS,
    allowRegistration: input.ALLOW_REGISTRATION,
    deploymentMode: input.DEPLOYMENT_MODE,
    defaultRuntimeUrl: input.defaultRuntimeUrl,
    runtimeAuthToken: input.runtimeAuthToken,
    allowCustomRuntime: input.ALLOW_CUSTOM_RUNTIME,
    runtimeAllowedHosts: input.runtimeAllowedHosts,
    runtimeAllowedPorts: input.runtimeAllowedPorts,
    runtimeTimeoutMs: input.RUNTIME_TIMEOUT_MS,
    runtimeStreamIdleTimeoutMs: input.RUNTIME_STREAM_IDLE_TIMEOUT_MS,
    maxRequestBytes: input.MAX_REQUEST_BYTES,
    maxMessageChars: input.MAX_MESSAGE_CHARS,
    maxFileBytes: input.MAX_FILE_BYTES,
    maxContextBytes: input.MAX_CONTEXT_BYTES,
    maxContextFiles: input.MAX_CONTEXT_FILES,
    maxStorageBytes: input.MAX_STORAGE_BYTES,
    loginMaxAttempts: input.LOGIN_MAX_ATTEMPTS,
    loginWindowMs: input.LOGIN_WINDOW_MINUTES * 60_000,
    loginBaseDelayMs: input.LOGIN_BASE_DELAY_MS,
    apiRateLimitPerMinute: input.API_RATE_LIMIT_PER_MINUTE,
    chatRateLimitPerMinute: input.CHAT_RATE_LIMIT_PER_MINUTE,
    enableCommandExecution: input.ENABLE_COMMAND_EXECUTION,
    commandAllowlist: input.commandAllowlist,
    commandTimeoutMs: input.COMMAND_TIMEOUT_MS,
    commandMaxOutputBytes: input.COMMAND_MAX_OUTPUT_BYTES,
    backupRetentionDays: input.BACKUP_RETENTION_DAYS,
    proposalTtlMs: input.PROPOSAL_TTL_MINUTES * 60_000,
  };
}

function normalizeRuntimeUrl(raw: string): string {
  const url = new URL(raw);
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function randomSecret(): string {
  // Solo para desarrollo local. En producción loadConfig exige SESSION_SECRET.
  return Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString('base64url');
}
