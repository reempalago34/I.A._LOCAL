import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import type { Store } from '../db.js';
import type { AuthenticatedSession } from '../types.js';
import { safeEqual, sha256 } from '../utils/crypto.js';
import { forbidden, unauthorized } from '../utils/errors.js';
import { type AuthService, CSRF_COOKIE, SESSION_COOKIE } from './service.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthenticatedSession | null;
    sessionHash: string | null;
  }
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function requireAuth(request: FastifyRequest): AuthenticatedSession {
  if (!request.auth) throw unauthorized();
  return request.auth;
}

export function isSecureOriginAllowed(
  request: FastifyRequest,
  config: AppConfig,
  origin: string,
): boolean {
  if (config.publicOrigin) return origin === config.publicOrigin;
  const host = request.headers.host;
  if (!host) return false;
  return origin === `${request.protocol}://${host}`;
}

export function registerAuthHooks(
  app: FastifyInstance,
  options: { store: Store; config: AppConfig; auth: AuthService },
): void {
  const { config, auth } = options;

  app.decorateRequest('auth', null);
  app.decorateRequest('sessionHash', null);

  app.addHook('onRequest', async (request, reply) => {
    request.auth = null;
    request.sessionHash = null;
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;

    const found = auth.resolveSession(token);
    if (!found) {
      reply.clearCookie(SESSION_COOKIE, {
        path: '/',
        sameSite: 'lax',
        secure: auth.cookieSecure(request.protocol),
      });
      return;
    }
    request.auth = found;
    request.sessionHash = sha256(token);
  });

  app.addHook('preHandler', async (request) => {
    if (!UNSAFE_METHODS.has(request.method)) return;
    if (!request.url.startsWith('/api/')) return;

    const origin = request.headers.origin;
    if (origin && !isSecureOriginAllowed(request, config, origin)) {
      throw forbidden('Origen de la solicitud no permitido.');
    }

    const cookieToken = request.cookies[CSRF_COOKIE];
    const headerToken = request.headers['x-csrf-token'];
    if (
      typeof cookieToken !== 'string' ||
      typeof headerToken !== 'string' ||
      !cookieToken ||
      !safeEqual(cookieToken, headerToken)
    ) {
      throw forbidden('Token CSRF inválido o ausente. Recarga la página.');
    }
    if (request.auth && !safeEqual(request.auth.session.csrfToken, headerToken)) {
      throw forbidden('Token CSRF no corresponde a la sesión.');
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });
}

export function setSessionCookies(
  reply: FastifyReply,
  auth: AuthService,
  protocol: string,
  session: { token: string; csrfToken: string; expiresAt: number },
): void {
  reply.setCookie(SESSION_COOKIE, session.token, auth.sessionCookieOptions(protocol));
  reply.setCookie(CSRF_COOKIE, session.csrfToken, auth.csrfCookieOptions(protocol));
}

export function clearSessionCookies(
  reply: FastifyReply,
  auth: AuthService,
  protocol: string,
): void {
  reply.clearCookie(SESSION_COOKIE, {
    path: '/',
    sameSite: 'lax',
    secure: auth.cookieSecure(protocol),
  });
  reply.clearCookie(CSRF_COOKIE, {
    path: '/',
    sameSite: 'lax',
    secure: auth.cookieSecure(protocol),
  });
}
