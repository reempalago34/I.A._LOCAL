import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executionScope, resolveRuntimeTarget } from '../src/runtime/url-policy.js';
import { collectSystemResources } from '../src/system/info.js';
import { makeTempDir, makeTestConfig } from './helpers.js';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFetch(signal?: AbortSignal) {
  void signal;
  return vi.fn(async (url: string | URL | Request) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === '/api/version') return jsonResponse({ version: '0.40.13' });
    if (pathname === '/api/tags') {
      return jsonResponse({
        models: [
          {
            name: 'modelo:prueba',
            size: 4_700_000_000,
            details: { parameter_size: '8B', quantization_level: 'Q4_K_M' },
          },
        ],
      });
    }
    if (pathname === '/api/ps') {
      return jsonResponse({
        models: [{ name: 'modelo:prueba', size: 5_000_000_000, size_vram: 4_800_000_000 }],
      });
    }
    if (pathname === '/api/show') {
      return jsonResponse({
        details: { parameter_size: '8B', quantization_level: 'Q4_K_M' },
        capabilities: ['completion'],
      });
    }
    return jsonResponse({ error: 'not found' }, 404);
  });
}

describe('perfil de ejecución', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir('forge-system-');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('marca "este computador" solo en despliegue local con runtime local', async () => {
    const local = makeTestConfig(dir, { DEPLOYMENT_MODE: 'local' });
    expect(executionScope(local, resolveRuntimeTarget('http://127.0.0.1:11434', local))).toBe(
      'this-computer',
    );
    const remote = makeTestConfig(dir, {
      DEPLOYMENT_MODE: 'local',
      RUNTIME_ALLOWED_HOSTS: '10.0.0.9',
    });
    expect(executionScope(remote, resolveRuntimeTarget('http://10.0.0.9:11434', remote))).toBe(
      'remote-server',
    );
    const server = makeTestConfig(dir, { DEPLOYMENT_MODE: 'server' });
    expect(executionScope(server, resolveRuntimeTarget('http://127.0.0.1:11434', server))).toBe(
      'remote-server',
    );
  });

  it('recopila RAM, disco, modelos cargados y evidencia de GPU', async () => {
    const config = makeTestConfig(dir, { DEPLOYMENT_MODE: 'server' });
    const target = resolveRuntimeTarget('http://127.0.0.1:11434', config);
    const resources = await collectSystemResources({
      config,
      target,
      modelName: 'modelo:prueba',
      fetchImpl: fakeFetch() as unknown as typeof fetch,
    });

    expect(resources.host.totalMemoryBytes).toBeGreaterThan(0);
    expect(resources.host.cpuCount).toBeGreaterThan(0);
    expect(resources.runtime.reachable).toBe(true);
    expect(resources.runtime.version).toBe('0.40.13');
    expect(resources.runtime.executionScope).toBe('remote-server');
    expect(resources.runtime.gpuActive).toBe(true);
    expect(resources.runtime.loadedModels[0]).toMatchObject({
      name: 'modelo:prueba',
      sizeVramBytes: 4_800_000_000,
    });
    expect(resources.model?.name).toBe('modelo:prueba');
    expect(resources.checks.map((check) => check.id)).toContain('execution');
    expect(resources.checks.find((check) => check.id === 'gpu')?.level).toBe('ok');
  });

  it('advierte del modo local experimental y no asume GPU', async () => {
    const config = makeTestConfig(dir, { DEPLOYMENT_MODE: 'local' });
    const target = resolveRuntimeTarget('http://127.0.0.1:11434', config);
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === '/api/version') return jsonResponse({ version: '0.40.13' });
      if (pathname === '/api/tags') return jsonResponse({ models: [] });
      if (pathname === '/api/ps') return jsonResponse({ models: [] });
      return jsonResponse({ error: 'not found' }, 404);
    });
    const resources = await collectSystemResources({
      config,
      target,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(resources.runtime.executionScope).toBe('this-computer');
    expect(resources.runtime.gpuActive).toBe(false);
    expect(resources.checks.find((check) => check.id === 'execution')?.level).toBe('warning');
    expect(resources.checks.find((check) => check.id === 'gpu')?.message).toContain('GPU');
    expect(resources.checks.some((check) => check.id === 'disk')).toBe(true);
  });

  it('informa del runtime caído sin romper la comprobación', async () => {
    const config = makeTestConfig(dir, { DEPLOYMENT_MODE: 'server' });
    const target = resolveRuntimeTarget('http://127.0.0.1:11434', config);
    const fetchImpl = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const resources = await collectSystemResources({
      config,
      target,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(resources.runtime.reachable).toBe(false);
    expect(resources.checks.find((check) => check.id === 'runtime')?.level).toBe('blocked');
    expect(resources.checks.find((check) => check.id === 'execution')?.level).toBe('ok');
  });
});
