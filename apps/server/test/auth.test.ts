import { describe, expect, it } from 'vitest';
import { cookieHeader, createTestApp, createTestUser, TEST_PASSWORD } from './helpers.js';

describe('autenticación y sesiones', () => {
  it('protege los endpoints de API sin sesión', async () => {
    const context = await createTestApp();
    try {
      const response = await context.app.inject({ method: 'GET', url: '/api/settings' });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHENTICATED');
    } finally {
      await context.cleanup();
    }
  });

  it('exige CSRF en métodos inseguros y valida el origen', async () => {
    const context = await createTestApp();
    try {
      const { user, csrfToken, cookie } = await createTestUser(context.auth);

      const missing = await context.app.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers: { cookie },
        payload: { language: 'en' },
      });
      expect(missing.statusCode).toBe(403);
      expect(missing.json().error.code).toBe('FORBIDDEN');

      const badOrigin = await context.app.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers: { cookie, 'x-csrf-token': csrfToken, origin: 'https://evil.example' },
        payload: { language: 'en' },
      });
      expect(badOrigin.statusCode).toBe(403);
      expect(badOrigin.json().error.message).toMatch(/Origen/);

      const ok = await context.app.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers: {
          cookie,
          'x-csrf-token': csrfToken,
          origin: 'http://localhost',
          host: 'localhost',
        },
        payload: { language: 'en' },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().settings.language).toBe('en');

      const unauthenticated = await context.app.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers: { 'x-csrf-token': csrfToken, cookie: `forge_csrf=${csrfToken}` },
        payload: { language: 'es' },
      });
      expect(unauthenticated.statusCode).toBe(401);
      expect(user.id).toBeTruthy();
    } finally {
      await context.cleanup();
    }
  });

  it('permite iniciar sesión, consultar la sesión y cerrarla', async () => {
    const context = await createTestApp();
    try {
      await createTestUser(context.auth, 'login@example.test');

      const csrf = await context.app.inject({ method: 'GET', url: '/api/auth/csrf' });
      expect(csrf.statusCode).toBe(200);
      const csrfToken = csrf.json().csrfToken as string;
      expect(csrfToken.length).toBeGreaterThanOrEqual(20);

      const login = await context.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: {
          'x-csrf-token': csrfToken,
          cookie: `forge_csrf=${csrfToken}`,
          'user-agent': 'vitest-browser',
        },
        payload: { email: 'LOGIN@example.test', password: TEST_PASSWORD },
      });
      expect(login.statusCode).toBe(200);
      expect(login.json().user.email).toBe('login@example.test');
      expect(login.json().user.passwordHash).toBeUndefined();

      const setCookie = login.headers['set-cookie'];
      const sessionToken = cookieHeader(setCookie, 'forge_sid');
      const sessionCsrf = cookieHeader(setCookie, 'forge_csrf');
      expect(sessionToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      expect(sessionCsrf).toBe(login.json().csrfToken);
      const rawCookies = Array.isArray(setCookie) ? setCookie.join('\n') : String(setCookie);
      expect(rawCookies).toMatch(/HttpOnly/i);
      expect(rawCookies).toMatch(/SameSite=Lax/i);

      const cookie = `forge_sid=${sessionToken}; forge_csrf=${sessionCsrf}`;
      const me = await context.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json().user.email).toBe('login@example.test');
      expect(me.json().csrfToken).toBe(sessionCsrf);

      const logout = await context.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie, 'x-csrf-token': sessionCsrf },
      });
      expect(logout.statusCode).toBe(200);

      const after = await context.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie },
      });
      expect(after.statusCode).toBe(401);
    } finally {
      await context.cleanup();
    }
  });

  it('aplica bloqueo tras demasiados intentos fallidos', async () => {
    const context = await createTestApp({ LOGIN_MAX_ATTEMPTS: '3' });
    try {
      await createTestUser(context.auth, 'locked@example.test');
      const csrf = await context.app.inject({ method: 'GET', url: '/api/auth/csrf' });
      const csrfToken = csrf.json().csrfToken as string;
      const headers = { 'x-csrf-token': csrfToken, cookie: `forge_csrf=${csrfToken}` };

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await context.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers,
          payload: { email: 'locked@example.test', password: 'Wrong-Password-123' },
        });
        expect(response.statusCode).toBe(401);
      }

      const blocked = await context.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers,
        payload: { email: 'locked@example.test', password: TEST_PASSWORD },
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error.code).toBe('RATE_LIMITED');
    } finally {
      await context.cleanup();
    }
  });

  it('rechaza registro cuando está deshabilitado', async () => {
    const context = await createTestApp({ ALLOW_REGISTRATION: 'false' });
    try {
      const csrf = await context.app.inject({ method: 'GET', url: '/api/auth/csrf' });
      const csrfToken = csrf.json().csrfToken as string;
      const response = await context.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers: { 'x-csrf-token': csrfToken, cookie: `forge_csrf=${csrfToken}` },
        payload: {
          email: 'new@example.test',
          password: 'Another-Strong-Password-42',
        },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('FORBIDDEN');
    } finally {
      await context.cleanup();
    }
  });

  it('registra usuarios cuando está habilitado y valida contraseñas débiles', async () => {
    const context = await createTestApp({ ALLOW_REGISTRATION: 'true' });
    try {
      const csrf = await context.app.inject({ method: 'GET', url: '/api/auth/csrf' });
      const csrfToken = csrf.json().csrfToken as string;
      const headers = { 'x-csrf-token': csrfToken, cookie: `forge_csrf=${csrfToken}` };

      const weak = await context.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers,
        payload: { email: 'weak@example.test', password: 'short' },
      });
      expect(weak.statusCode).toBe(400);
      expect(weak.json().error.code).toBe('WEAK_PASSWORD');

      const badEmail = await context.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers,
        payload: { email: 'not-an-email', password: 'A-very-strong-passphrase-9' },
      });
      expect(badEmail.statusCode).toBe(400);
      expect(badEmail.json().error.code).toBe('VALIDATION_ERROR');

      const weakPolicy = await context.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers,
        payload: { email: 'weak2@example.test', password: 'password1234' },
      });
      expect(weakPolicy.statusCode).toBe(400);
      expect(weakPolicy.json().error.code).toBe('WEAK_PASSWORD');

      const ok = await context.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers,
        payload: {
          email: 'resilient@example.test',
          password: 'A-very-robust-passphrase-9',
          displayName: 'Strong User',
        },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().user.email).toBe('resilient@example.test');
      expect(ok.json().user.displayName).toBe('Strong User');
    } finally {
      await context.cleanup();
    }
  });

  it('no permite reutilizar correos ni exponer el hash de contraseña', async () => {
    const context = await createTestApp();
    try {
      const { user } = await createTestUser(context.auth, 'repeat@example.test');
      expect(user.passwordHash).toMatch(/^\$argon2id\$/);
      await expect(
        context.auth.createUser({
          email: 'REPEAT@example.test',
          password: 'Another-Strong-Password-42',
        }),
      ).rejects.toMatchObject({ code: 'EMAIL_EXISTS' });
    } finally {
      await context.cleanup();
    }
  });
});
