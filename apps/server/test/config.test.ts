import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { makeTempDir } from './helpers.js';

const BASE = {
  NODE_ENV: 'test',
  SESSION_SECRET: 'a'.repeat(48),
};

describe('loadConfig', () => {
  it('aplica valores por defecto seguros en desarrollo/test', async () => {
    const dir = await makeTempDir();
    const config = loadConfig({ cwd: dir, env: BASE });
    expect(config.env).toBe('test');
    expect(config.deploymentMode).toBe('local');
    expect(config.allowRegistration).toBe(false);
    expect(config.enableCommandExecution).toBe(false);
    expect(config.cookieSecure).toBe('auto');
    expect(config.projectsRoot).toBe(`${process.env.HOME}/ForgeProjects`);
    expect(config.databasePath).toBe(`${dir}/data/forge.sqlite`);
    expect(config.runtimeAllowedHosts.has('127.0.0.1')).toBe(true);
    expect(config.runtimeAllowedPorts.has(11434)).toBe(true);
    expect(config.runtimeNumCtx).toBe(8_192);
  });

  it('exige SESSION_SECRET en producción', async () => {
    const dir = await makeTempDir();
    expect(() => loadConfig({ cwd: dir, env: { NODE_ENV: 'production' } })).toThrow(
      /SESSION_SECRET/,
    );
  });

  it('rechaza el secreto de ejemplo en producción', async () => {
    const dir = await makeTempDir();
    expect(() =>
      loadConfig({
        cwd: dir,
        env: {
          NODE_ENV: 'production',
          SESSION_SECRET: 'change-me-to-a-long-random-value-32chars',
        },
      }),
    ).toThrow(/valor de ejemplo/);
  });

  it('valida variables numéricas y de URL', async () => {
    const dir = await makeTempDir();
    expect(() => loadConfig({ cwd: dir, env: { ...BASE, PORT: '0' } })).toThrow(
      /Configuración inválida/,
    );
    expect(() => loadConfig({ cwd: dir, env: { ...BASE, OLLAMA_BASE_URL: 'not-a-url' } })).toThrow(
      /Configuración inválida/,
    );
    expect(() => loadConfig({ cwd: dir, env: { ...BASE, MAX_CONTEXT_FILES: '999' } })).toThrow(
      /Configuración inválida/,
    );
    expect(() => loadConfig({ cwd: dir, env: { ...BASE, RUNTIME_NUM_CTX: '100' } })).toThrow(
      /Configuración inválida/,
    );
  });

  it('separa listas de hosts, puertos y allowlist de comandos', async () => {
    const dir = await makeTempDir();
    const config = loadConfig({
      cwd: dir,
      env: {
        ...BASE,
        RUNTIME_ALLOWED_HOSTS: 'gpu-box, 10.1.2.3',
        RUNTIME_ALLOWED_PORTS: '8080, 99999, nope',
        COMMAND_ALLOWLIST: ' git status, node --version ,, npm test , node ',
      },
    });
    expect(config.runtimeAllowedHosts.has('gpu-box')).toBe(true);
    expect(config.runtimeAllowedHosts.has('10.1.2.3')).toBe(true);
    expect(config.runtimeAllowedPorts.has(8080)).toBe(true);
    expect(config.runtimeAllowedPorts.has(99999)).toBe(false);
    expect(config.commandAllowlist).toEqual(['git status', 'node --version', 'npm test']);
  });

  it('genera un secreto efímero cuando no se configura fuera de producción', async () => {
    const dir = await makeTempDir();
    const config = loadConfig({ cwd: dir, env: { NODE_ENV: 'development' } });
    expect(config.sessionSecret.length).toBeGreaterThanOrEqual(32);
    expect(config.generatedSessionSecret).toBe(true);
  });
});
