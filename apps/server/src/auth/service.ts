import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { Store } from '../db.js';
import type { AuthenticatedSession, PublicUser, UserRecord } from '../types.js';
import { hmacKey, randomToken, sha256, sleep } from '../utils/crypto.js';
import { AppError, tooManyRequests, unauthorized } from '../utils/errors.js';
import { assertStrongPassword, hashPassword, verifyPassword } from './passwords.js';

export const SESSION_COOKIE = 'forge_sid';
export const CSRF_COOKIE = 'forge_csrf';

export interface RequestContext {
  ip: string;
  userAgent?: string;
}

export interface CreatedSession {
  token: string;
  csrfToken: string;
  expiresAt: number;
}

export function toPublicUser(user: UserRecord): PublicUser {
  const { passwordHash: _passwordHash, ...rest } = user;
  return rest;
}

export class AuthService {
  #dummyHashPromise: Promise<string> | null = null;

  constructor(
    private readonly store: Store,
    private readonly config: AppConfig,
  ) {}

  async hashPassword(password: string): Promise<string> {
    return hashPassword(password);
  }

  async createUser(input: {
    email: string;
    password: string;
    displayName?: string;
    role?: 'admin' | 'user';
  }): Promise<UserRecord> {
    const email = normalizeEmail(input.email);
    assertStrongPassword(input.password, email);
    if (this.store.findUserByEmail(email)) {
      throw new AppError(409, 'EMAIL_EXISTS', 'Ya existe una cuenta con ese correo.');
    }
    const passwordHash = await hashPassword(input.password);
    return this.store.createUser({
      id: randomUUID(),
      email,
      displayName: input.displayName?.trim().slice(0, 80) || email.split('@')[0]!,
      passwordHash,
      role: input.role ?? 'user',
      now: Date.now(),
    });
  }

  async login(input: {
    email: string;
    password: string;
    context: RequestContext;
  }): Promise<{ user: UserRecord; session: CreatedSession }> {
    const email = normalizeEmail(input.email);
    const ipKey = hmacKey(this.config.sessionSecret, `ip:${input.context.ip}`);
    const userKey = hmacKey(this.config.sessionSecret, `user:${input.context.ip}:${email}`);
    const now = Date.now();
    const since = now - this.config.loginWindowMs;

    const ipAttempts = this.store.countRecentLoginAttempts(ipKey, since);
    const userAttempts = this.store.countRecentLoginAttempts(userKey, since);
    const attempts = Math.max(ipAttempts, userAttempts);
    if (attempts >= this.config.loginMaxAttempts) {
      throw tooManyRequests(
        'Demasiados intentos de acceso. Espera antes de volver a intentarlo.',
        Math.ceil(this.config.loginWindowMs / 1000),
      );
    }

    const user = this.store.findUserByEmail(email);
    const passwordOk = user
      ? await verifyPassword(input.password, user.passwordHash)
      : await this.#verifyDummy(input.password);

    if (!user || !passwordOk) {
      this.store.recordLoginAttempt(ipKey, now);
      this.store.recordLoginAttempt(userKey, now);
      await sleep(Math.min(this.config.loginBaseDelayMs + attempts * 250, 2_000));
      throw unauthorized('Correo o contraseña incorrectos.');
    }

    this.store.clearLoginAttempts(ipKey);
    this.store.clearLoginAttempts(userKey);
    const session = this.createSession(user.id, input.context);
    return { user, session };
  }

  createSession(userId: string, context: RequestContext): CreatedSession {
    const token = randomToken(32);
    const csrfToken = randomToken(32);
    const now = Date.now();
    const expiresAt = now + this.config.sessionTtlHours * 3_600_000;
    this.store.createSession({
      id: sha256(token),
      userId,
      csrfToken,
      createdAt: now,
      expiresAt,
      lastSeenAt: now,
      ipHash: hmacKey(this.config.sessionSecret, `ip:${context.ip}`),
      userAgent: context.userAgent?.slice(0, 200) ?? null,
    });
    return { token, csrfToken, expiresAt };
  }

  resolveSession(token: string): AuthenticatedSession | null {
    const found = this.store.findSessionWithUser(sha256(token));
    if (!found) return null;
    const now = Date.now();
    if (now >= found.session.expiresAt) {
      this.store.deleteSession(found.session.id);
      return null;
    }
    if (now - found.session.lastSeenAt > this.config.sessionIdleHours * 3_600_000) {
      this.store.deleteSession(found.session.id);
      return null;
    }
    if (now - found.session.lastSeenAt > 300_000) {
      this.store.touchSession(found.session.id, now);
      found.session.lastSeenAt = now;
    }
    return found;
  }

  destroySession(sessionId: string): void {
    this.store.deleteSession(sessionId);
  }

  destroyAllSessions(userId: string): void {
    this.store.deleteOtherSessions(userId);
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = this.store.findUserById(userId);
    if (!user) throw unauthorized();
    const ok = await verifyPassword(currentPassword, user.passwordHash);
    if (!ok) {
      await sleep(300);
      throw new AppError(400, 'INVALID_PASSWORD', 'La contraseña actual no es correcta.');
    }
    assertStrongPassword(newPassword, user.email);
    if (await verifyPassword(newPassword, user.passwordHash)) {
      throw new AppError(400, 'SAME_PASSWORD', 'La nueva contraseña debe ser diferente.');
    }
    const passwordHash = await hashPassword(newPassword);
    this.store.updateUserPassword(userId, passwordHash, Date.now());
    this.store.deleteOtherSessions(userId);
  }

  cookieSecure(protocol: string): boolean {
    if (this.config.cookieSecure === 'true') return true;
    if (this.config.cookieSecure === 'false') return false;
    if (protocol === 'https') return true;
    return Boolean(this.config.publicOrigin?.startsWith('https://'));
  }

  sessionCookieOptions(protocol: string) {
    return {
      httpOnly: true,
      secure: this.cookieSecure(protocol),
      sameSite: 'lax' as const,
      path: '/',
      maxAge: this.config.sessionTtlHours * 3_600,
    };
  }

  csrfCookieOptions(protocol: string) {
    return {
      httpOnly: false,
      secure: this.cookieSecure(protocol),
      sameSite: 'lax' as const,
      path: '/',
      maxAge: 2 * 3_600,
    };
  }

  async #verifyDummy(password: string): Promise<boolean> {
    if (!this.#dummyHashPromise) {
      this.#dummyHashPromise = hashPassword(randomToken(24));
    }
    return verifyPassword(password, await this.#dummyHashPromise);
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
