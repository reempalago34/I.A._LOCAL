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

  it('detecta nombres evidentemente sensibles', () => {
    expect(isObviouslySecretName('api_token.txt')).toBe(true);
    expect(isObviouslySecretName('my-secret-value')).toBe(true);
    expect(isObviouslySecretName('credentials')).toBe(true);
    expect(isObviouslySecretName('tokenizer.ts')).toBe(false);
    expect(isObviouslySecretName('notes.md')).toBe(false);
  });
});
