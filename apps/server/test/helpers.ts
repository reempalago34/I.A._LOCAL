import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type BuiltApp, buildApp } from '../src/app.js';
import type { CreatedSession } from '../src/auth/service.js';
import { AuthService } from '../src/auth/service.js';
import { type AppConfig, loadConfig } from '../src/config.js';
import type { UserRecord } from '../src/types.js';

export const TEST_PASSWORD = 'Forge-Test-Pass-2026';

const BASE_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: '8080',
  LOG_LEVEL: 'silent',
  COOKIE_SECURE: 'false',
  SESSION_SECRET: randomBytes(32).toString('hex'),
  SESSION_TTL_HOURS: '24',
  SESSION_IDLE_HOURS: '12',
  ALLOW_REGISTRATION: 'true',
  DEPLOYMENT_MODE: 'local',
  OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
  ALLOW_CUSTOM_RUNTIME: 'true',
  RUNTIME_TIMEOUT_MS: '5000',
  RUNTIME_STREAM_IDLE_TIMEOUT_MS: '5000',
  MAX_REQUEST_BYTES: '1048576',
  MAX_MESSAGE_CHARS: '20000',
  MAX_FILE_BYTES: '262144',
  MAX_CONTEXT_BYTES: '524288',
  MAX_CONTEXT_FILES: '12',
  MAX_STORAGE_BYTES: '67108864',
  LOGIN_MAX_ATTEMPTS: '5',
  LOGIN_WINDOW_MINUTES: '15',
  LOGIN_BASE_DELAY_MS: '0',
  API_RATE_LIMIT_PER_MINUTE: '1000',
  CHAT_RATE_LIMIT_PER_MINUTE: '20',
  ENABLE_COMMAND_EXECUTION: 'false',
  COMMAND_ALLOWLIST:
    'git status,git diff,git log,git show,git rev-parse,git ls-files,node --version,npm --version,npm test,npm run build',
  COMMAND_TIMEOUT_MS: '10000',
  COMMAND_MAX_OUTPUT_BYTES: '65536',
  BACKUP_RETENTION_DAYS: '7',
  PROPOSAL_TTL_MINUTES: '120',
};

export async function makeTempDir(prefix = 'forge-test-'): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export function makeTestConfig(dir: string, overrides: NodeJS.ProcessEnv = {}): AppConfig {
  return loadConfig({
    cwd: dir,
    env: {
      ...BASE_ENV,
      DATA_DIR: path.join(dir, 'data'),
      PROJECTS_ROOT: path.join(dir, 'projects'),
      WEB_DIST: path.join(dir, 'web-dist'),
      ...overrides,
    },
  });
}

export interface TestSession {
  user: UserRecord;
  session: CreatedSession;
  cookie: string;
  csrfToken: string;
}

export async function createTestUser(
  auth: AuthService,
  email = 'dev@example.test',
): Promise<TestSession> {
  const user = await auth.createUser({
    email,
    password: TEST_PASSWORD,
    displayName: 'Dev',
  });
  const session = auth.createSession(user.id, {
    ip: '127.0.0.1',
    userAgent: 'vitest',
  });
  return {
    user,
    session,
    cookie: `forge_sid=${session.token}; forge_csrf=${session.csrfToken}`,
    csrfToken: session.csrfToken,
  };
}

export interface TestApp extends BuiltApp {
  dir: string;
  auth: AuthService;
  cleanup: () => Promise<void>;
}

export async function createTestApp(
  overrides: NodeJS.ProcessEnv = {},
  options: Pick<Parameters<typeof buildApp>[0], 'runtimeFactory'> = {},
): Promise<TestApp> {
  const dir = await makeTempDir();
  const config = makeTestConfig(dir, overrides);
  const built = await buildApp({
    config,
    serveStatic: false,
    ...(options.runtimeFactory ? { runtimeFactory: options.runtimeFactory } : {}),
  });
  const auth = new AuthService(built.store, config);
  return {
    ...built,
    dir,
    auth,
    cleanup: async () => {
      await built.app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export function cookieHeader(setCookie: string | string[] | undefined, name: string): string {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const value of values) {
    const match = value.match(new RegExp(`(?:^|,\\s*)${name}=([^;]*)`));
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return '';
}

export function parseSse(payload: string): { event: string; data: unknown }[] {
  const events: { event: string; data: unknown }[] = [];
  for (const block of payload.split('\n\n')) {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (data.length === 0) continue;
    const raw = data.join('\n');
    try {
      events.push({ event, data: JSON.parse(raw) as unknown });
    } catch {
      events.push({ event, data: raw });
    }
  }
  return events;
}
