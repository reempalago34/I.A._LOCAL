import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { randomToken } from '../utils/crypto.js';
import { forbidden } from '../utils/errors.js';
import { clearSessionCookies, requireAuth, setSessionCookies } from './hooks.js';
import { type AuthService, CSRF_COOKIE, normalizeEmail, toPublicUser } from './service.js';

const credentialsSchema = z.object({
  email: z.string().email('Correo inválido.').max(254),
  password: z.string().min(1, 'La contraseña es obligatoria.').max(200),
});

const registerSchema = credentialsSchema.extend({
  displayName: z.string().trim().min(1).max(80).optional(),
});

const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(12).max(200),
});

export function registerAuthRoutes(
  app: FastifyInstance,
  options: { config: AppConfig; auth: AuthService },
): void {
  const { config, auth } = options;

  app.get('/api/auth/config', async () => {
    return {
      registrationEnabled: config.allowRegistration,
      deploymentMode: config.deploymentMode,
      commandExecutionEnabled: config.enableCommandExecution,
      telemetry: false,
    };
  });

  app.get('/api/auth/csrf', async (request, reply) => {
    const sessionToken = request.auth?.session.csrfToken;
    const existing = request.cookies[CSRF_COOKIE];
    const token =
      sessionToken ??
      (typeof existing === 'string' && existing.length >= 20 ? existing : randomToken(32));
    reply.setCookie(CSRF_COOKIE, token, auth.csrfCookieOptions(request.protocol));
    return { csrfToken: token };
  });

  app.get('/api/auth/me', async (request, reply) => {
    const { user } = requireAuth(request);
    reply.setCookie(
      CSRF_COOKIE,
      request.auth!.session.csrfToken,
      auth.csrfCookieOptions(request.protocol),
    );
    return {
      user: toPublicUser(user),
      csrfToken: request.auth!.session.csrfToken,
      registrationEnabled: config.allowRegistration,
    };
  });

  app.post(
    '/api/auth/login',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const body = credentialsSchema.parse(request.body);
      const result = await auth.login({
        email: normalizeEmail(body.email),
        password: body.password,
        context: { ip: request.ip, userAgent: request.headers['user-agent'] },
      });
      setSessionCookies(reply, auth, request.protocol, result.session);
      return {
        user: toPublicUser(result.user),
        csrfToken: result.session.csrfToken,
      };
    },
  );

  app.post(
    '/api/auth/register',
    {
      config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
    },
    async (request, reply) => {
      if (!config.allowRegistration) {
        throw forbidden('El registro público está deshabilitado. Pide acceso al administrador.');
      }
      const body = registerSchema.parse(request.body);
      const user = await auth.createUser({
        email: normalizeEmail(body.email),
        password: body.password,
        displayName: body.displayName,
      });
      const session = auth.createSession(user.id, {
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });
      setSessionCookies(reply, auth, request.protocol, session);
      return { user: toPublicUser(user), csrfToken: session.csrfToken };
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    const { session } = requireAuth(request);
    auth.destroySession(session.id);
    clearSessionCookies(reply, auth, request.protocol);
    return { ok: true };
  });

  app.post('/api/auth/password', async (request, reply) => {
    const { user } = requireAuth(request);
    const body = passwordChangeSchema.parse(request.body);
    await auth.changePassword(user.id, body.currentPassword, body.newPassword);
    clearSessionCookies(reply, auth, request.protocol);
    return { ok: true, message: 'Contraseña actualizada. Inicia sesión de nuevo.' };
  });
}
