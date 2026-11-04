import { describe, expect, it } from 'vitest';
import {
  createExclusionMatcher,
  isObviouslySecretName,
  sanitizePatterns,
} from '../src/files/exclusions.js';
import { isInside, normalizeRelativePath } from '../src/files/paths.js';
import { AppError } from '../src/utils/errors.js';

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error(`Se esperaba un error ${code}`);
}

describe('normalizeRelativePath', () => {
  it('normaliza separadores y segmentos vacíos', () => {
    expect(normalizeRelativePath('src\\components//Button.tsx')).toBe('src/components/Button.tsx');
    expect(normalizeRelativePath('./src/./index.ts')).toBe('src/index.ts');
    expect(normalizeRelativePath('')).toBe('');
  });

  it('bloquea traversal, rutas absolutas y home', () => {
    expectCode(() => normalizeRelativePath('../secret.txt', false), 'PATH_TRAVERSAL');
    expectCode(() => normalizeRelativePath('src/../../secret.txt'), 'PATH_TRAVERSAL');
    expectCode(() => normalizeRelativePath('/etc/passwd', false), 'INVALID_PATH');
    expectCode(() => normalizeRelativePath('C:\\Windows\\win.ini', false), 'INVALID_PATH');
    expectCode(() => normalizeRelativePath('~/secret', false), 'INVALID_PATH');
  });

  it('rechaza rutas vacías cuando no se permiten y cadenas con NUL', () => {
    expectCode(() => normalizeRelativePath('', false), 'INVALID_PATH');
    expectCode(() => normalizeRelativePath('src/\0evil', false), 'INVALID_PATH');
    expectCode(() => normalizeRelativePath('a'.repeat(1_025), false), 'INVALID_PATH');
  });

  it('verifica contención de rutas', () => {
    expect(isInside('/srv/projects', '/srv/projects/app/src')).toBe(true);
    expect(isInside('/srv/projects', '/srv/projects')).toBe(true);
    expect(isInside('/srv/projects', '/srv/projects-other')).toBe(false);
    expect(isInside('/srv/projects', '/etc')).toBe(false);
  });
});

describe('exclusiones de archivos', () => {
  const matcher = createExclusionMatcher();

  it('excluye directorios y secretos por defecto', () => {
    expect(matcher.isExcluded('node_modules/react/index.js')).toBe(true);
    expect(matcher.isExcluded('src/node_modules/react/index.js')).toBe(true);
    expect(matcher.isExcluded('.git/config')).toBe(true);
    expect(matcher.isExcluded('dist/app.js')).toBe(true);
    expect(matcher.isExcluded('.env')).toBe(true);
    expect(matcher.isExcluded('.env.local')).toBe(true);
    expect(matcher.isExcluded('config/production.env')).toBe(true);
    expect(matcher.isExcluded('certs/server.pem')).toBe(true);
    expect(matcher.isExcluded('keys/id_rsa')).toBe(true);
    expect(matcher.isExcluded('assets/logo.png')).toBe(true);
    expect(matcher.isExcluded('db/forge.sqlite')).toBe(true);
  });

  it('excluye secretos sin distinguir mayúsculas', () => {
    for (const path of [
      '.env',
      '.ENV',
      '.Env',
      'config/Secrets.json',
      'SECRETS.txt',
      'Credentials.json',
      'id_RSA',
      'server.PEM',
    ]) {
      expect(matcher.isExcluded(path), path).toBe(true);
    }
  });

  it('no excluye código legítimo con palabras parecidas a secretos', () => {
    for (const path of [
      'tokenizer.ts',
      'src/auth/token.ts',
      'design-tokens.css',
      'src/build/index.ts',
      'package.json',
      'Dockerfile',
    ]) {
      expect(matcher.isExcluded(path), path).toBe(false);
    }
  });

  it('bloquea dependencias a cualquier profundidad y salidas solo en la raíz', () => {
    expect(matcher.isExcluded('packages/app/node_modules/lib/index.js')).toBe(true);
    expect(matcher.isExcluded('src/.venv/lib/python.py')).toBe(true);
    expect(matcher.isExcluded('dist/assets/app.js')).toBe(true);
    expect(matcher.isExcluded('coverage/lcov.info')).toBe(true);
    expect(matcher.isExcluded('src/dist/generated.js')).toBe(false);
    expect(matcher.isExcluded('src/out/generated.js')).toBe(false);
    expect(matcher.isExcluded('src/target/generated.rs')).toBe(false);
  });

  it('permite código y documentación normales', () => {
    expect(matcher.isExcluded('src/index.ts')).toBe(false);
    expect(matcher.isExcluded('README.md')).toBe(false);
    expect(matcher.isExcluded('docs/architecture.md')).toBe(false);
  });

  it('respeta patrones adicionales del usuario', () => {
    const custom = createExclusionMatcher(['fixtures/**', '*.snap']);
    expect(custom.isExcluded('fixtures/data.json')).toBe(true);
    expect(custom.isExcluded('src/button.snap')).toBe(true);
    expect(custom.isExcluded('src/button.ts')).toBe(false);
  });

  it('sanea patrones peligrosos o inválidos', () => {
    expect(
      sanitizePatterns(['  good/** ', '!negated', 'bad\0pattern', '', 'x'.repeat(201)]),
    ).toEqual(['good/**']);
  });

  it('detecta nombres evidentemente sensibles sin marcar código', () => {
    expect(isObviouslySecretName('api_token.txt')).toBe(true);
    expect(isObviouslySecretName('my-secret-value')).toBe(true);
    expect(isObviouslySecretName('credentials')).toBe(true);
    expect(isObviouslySecretName('tokenizer.ts')).toBe(false);
    expect(isObviouslySecretName('token.ts')).toBe(false);
    expect(isObviouslySecretName('design-tokens.css')).toBe(false);
    expect(isObviouslySecretName('notes.md')).toBe(false);
  });
});
