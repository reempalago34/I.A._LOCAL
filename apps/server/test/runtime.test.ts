import { describe, expect, it, vi } from 'vitest';
import { estimateRequirements, parseParameterCount } from '../src/runtime/hardware.js';
import { OllamaRuntime } from '../src/runtime/ollama.js';
import {
  classifyRuntimeLocation,
  isBlockedAddress,
  parseRuntimeUrl,
  resolveRuntimeTarget,
} from '../src/runtime/url-policy.js';
import { AppError } from '../src/utils/errors.js';
import { makeTempDir, makeTestConfig } from './helpers.js';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function collect(
  generator: AsyncGenerator<{ type: string; text?: string; usage?: unknown }>,
): Promise<{ type: string; text?: string; usage?: unknown }[]> {
  const chunks: { type: string; text?: string; usage?: unknown }[] = [];
  for await (const chunk of generator) chunks.push(chunk);
  return chunks;
}

describe('política de URLs del runtime', () => {
  it('clasifica direcciones locales, privadas y remotas', () => {
    expect(classifyRuntimeLocation('localhost')).toBe('local');
    expect(classifyRuntimeLocation('127.0.0.1')).toBe('local');
    expect(classifyRuntimeLocation('127.8.9.10')).toBe('local');
    expect(classifyRuntimeLocation('::1')).toBe('local');
    expect(classifyRuntimeLocation('10.1.2.3')).toBe('private');
    expect(classifyRuntimeLocation('172.16.0.5')).toBe('private');
    expect(classifyRuntimeLocation('172.32.0.5')).toBe('remote');
    expect(classifyRuntimeLocation('192.168.1.10')).toBe('private');
    expect(classifyRuntimeLocation('gpu-box.local')).toBe('private');
    expect(classifyRuntimeLocation('ollama')).toBe('private');
    expect(classifyRuntimeLocation('8.8.8.8')).toBe('remote');
    expect(classifyRuntimeLocation('forge.example.com')).toBe('remote');
  });

  it('rechaza URLs mal formadas, con credenciales o parámetros', () => {
    expect(() => parseRuntimeUrl('not-a-url')).toThrow(AppError);
    expect(() => parseRuntimeUrl('ftp://127.0.0.1')).toThrow(/http o https/);
    expect(() => parseRuntimeUrl('http://user:pass@127.0.0.1:11434')).toThrow(/credenciales/);
    expect(() => parseRuntimeUrl('http://127.0.0.1:11434?x=1')).toThrow(/parámetros/);
    expect(parseRuntimeUrl('http://127.0.0.1:11434/').toString()).toBe('http://127.0.0.1:11434/');
  });

  it('normaliza y valida hosts y puertos permitidos', async () => {
    const dir = await makeTempDir();
    const config = makeTestConfig(dir, {
      RUNTIME_ALLOWED_HOSTS: '10.20.30.40,gpu.local',
    });

    const local = resolveRuntimeTarget('http://127.0.0.1:11434/', config);
    expect(local).toMatchObject({
      url: 'http://127.0.0.1:11434',
      hostname: '127.0.0.1',
      port: 11434,
      location: 'local',
      isLocal: true,
    });

    const privateTarget = resolveRuntimeTarget('http://10.20.30.40:11434', config);
    expect(privateTarget.location).toBe('private');
    expect(privateTarget.isLocal).toBe(false);

    expect(() => resolveRuntimeTarget('http://evil.example:11434', config)).toThrow(
      /host del runtime/,
    );
    expect(() => resolveRuntimeTarget('http://127.0.0.1:8080', config)).toThrow(
      /puerto del runtime/,
    );
  });

  it('bloquea direcciones de metadatos y comodines', async () => {
    const dir = await makeTempDir();
    const config = makeTestConfig(dir, { RUNTIME_ALLOWED_HOSTS: '*' });
    expect(() => resolveRuntimeTarget('http://169.254.169.254:11434', config)).toThrow(/bloqueada/);
    expect(isBlockedAddress('0.0.0.0')).toBe(true);
    expect(isBlockedAddress('metadata.google.internal')).toBe(true);
    expect(isBlockedAddress('127.0.0.1')).toBe(false);
  });

  it('impide cambiar la URL si el administrador la fijó', async () => {
    const dir = await makeTempDir();
    const config = makeTestConfig(dir, {
      ALLOW_CUSTOM_RUNTIME: 'false',
      OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
      RUNTIME_ALLOWED_HOSTS: '10.0.0.9',
    });
    expect(() => resolveRuntimeTarget('http://10.0.0.9:11434', config)).toThrow(
      /No se puede cambiar/,
    );
    expect(resolveRuntimeTarget('http://127.0.0.1:11434', config).location).toBe('local');
  });
});

describe('estimación de hardware', () => {
  it('interpreta tamaños de parámetros', () => {
    expect(parseParameterCount({ parameterSize: '7B' })).toBe(7e9);
    expect(parseParameterCount({ parameterSize: '1.5B' })).toBe(1.5e9);
    expect(parseParameterCount({ parameterSize: '300M' })).toBe(300e6);
    expect(parseParameterCount({ parameterSize: '8x7B' })).toBe(56e9);
    expect(parseParameterCount({ parameterSize: 'n/a' })).toBeNull();
    expect(parseParameterCount({ parameterCount: 2e9, parameterSize: '7B' })).toBe(2e9);
  });

  it('estima RAM y disco de forma conservadora', () => {
    const estimate = estimateRequirements({
      sizeBytes: 4_500_000_000,
      parameterSize: '8B',
      quantizationLevel: 'Q4_K_M',
      contextLength: 8_192,
    });
    expect(estimate.diskBytes).toBe(4_500_000_000);
    expect(estimate.estimatedRamBytes).toBeGreaterThan(5_000_000_000);
    expect(estimate.estimateQuality).toBe('rough');
    expect(estimate.notes.length).toBeGreaterThanOrEqual(2);

    const unknown = estimateRequirements({ sizeBytes: 100 });
    expect(unknown.estimatedRamBytes).toBeNull();
    expect(unknown.estimateQuality).toBe('unknown');
  });
});

describe('OllamaRuntime', () => {
  it('consulta salud y modelos con autenticación opcional', async () => {
    const dir = await makeTempDir();
    const config = makeTestConfig(dir, { OLLAMA_AUTH_TOKEN: 'runtime-secret' });
    const target = resolveRuntimeTarget('http://127.0.0.1:11434', config);
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === '/api/version') return jsonResponse({ version: '0.40.13' });
      if (pathname === '/api/tags') {
        return jsonResponse({
          models: [
            {
              name: 'llama3:8b',
              size: 4_700_000_000,
              digest: 'sha256:abc',
              details: { parameter_size: '8B', quantization_level: 'Q4_K_M' },
            },
          ],
        });
      }
      return jsonResponse({ error: 'not found' }, 404);
    });

    const runtime = new OllamaRuntime({
      target,
      config,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const status = await runtime.health();
    expect(status).toMatchObject({ reachable: true, version: '0.40.13', modelCount: 1 });

    const models = await runtime.listModels();
    expect(models[0]).toMatchObject({
      name: 'llama3:8b',
      sizeBytes: 4_700_000_000,
      details: { parameterSize: '8B', quantizationLevel: 'Q4_K_M' },
    });
    expect(models[0]?.requirements.estimatedRamBytes).toBeGreaterThan(0);
    expect(fetchImpl).toHaveBeenCalled();
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer runtime-secret');
  });

  it('informa de runtime fuera de línea sin filtrar detalles internos', async () => {
    const dir = await makeTempDir();
    const config = makeTestConfig(dir);
    const target = resolveRuntimeTarget('http://127.0.0.1:11434', config);
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
        cause: { code: 'ECONNREFUSED' },
      });
    });
    const runtime = new OllamaRuntime({
      target,
      config,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const status = await runtime.health();
    expect(status.reachable).toBe(false);
    expect(status.error).toEqual({
      code: 'RUNTIME_OFFLINE',
      message: 'No se pudo contactar con el runtime de modelos.',
    });
  });

  it('transmite deltas y uso de tokens', async () => {
    const dir = await makeTempDir();
    const config = makeTestConfig(dir);
    const target = resolveRuntimeTarget('http://127.0.0.1:11434', config);
    const body = [
      '{"message":{"content":"Hola"},"done":false}',
      '{"message":{"content":" mundo"},"done":false}',
      '{"message":{"content":"!"},"done":true,"prompt_eval_count":4,"eval_count":3,"total_duration":1500000000}',
    ].join('\n');
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
    const runtime = new OllamaRuntime({
      target,
      config,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const chunks = await collect(
      runtime.chat(
        { model: 'llama3', messages: [{ role: 'user', content: 'Hola' }] },
        new AbortController().signal,
      ),
    );
    expect(chunks).toEqual([
      { type: 'delta', text: 'Hola' },
      { type: 'delta', text: ' mundo' },
      { type: 'delta', text: '!' },
      {
        type: 'done',
        usage: { promptTokens: 4, completionTokens: 3, totalDurationMs: 1500 },
      },
    ]);
  });

  it('mapea errores HTTP del runtime a códigos claros', async () => {
    const dir = await makeTempDir();
    const config = makeTestConfig(dir);
    const target = resolveRuntimeTarget('http://127.0.0.1:11434', config);

    const cases: [number, string][] = [
      [404, 'MODEL_NOT_FOUND'],
      [401, 'RUNTIME_UNAUTHORIZED'],
      [429, 'RUNTIME_BUSY'],
      [500, 'RUNTIME_HTTP_ERROR'],
    ];
    for (const [status, code] of cases) {
      const runtime = new OllamaRuntime({
        target,
        config,
        fetchImpl: (async () =>
          jsonResponse(
            { error: 'fallo interno en http://secreto.local/x' },
            status,
          )) as unknown as typeof fetch,
      });
      try {
        await collect(
          runtime.chat(
            { model: 'llama3', messages: [{ role: 'user', content: 'x' }] },
            new AbortController().signal,
          ),
        );
        throw new Error('Se esperaba un error');
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe(code);
        expect((error as AppError).message).not.toContain('secreto.local');
      }
    }
  });

  it('rechaza líneas inválidas y errores reportados en el stream', async () => {
    const dir = await makeTempDir();
    const config = makeTestConfig(dir);
    const target = resolveRuntimeTarget('http://127.0.0.1:11434', config);

    const invalid = new OllamaRuntime({
      target,
      config,
      fetchImpl: (async () =>
        new Response('no-json\n', { status: 200 })) as unknown as typeof fetch,
    });
    await expect(
      collect(
        invalid.chat(
          { model: 'llama3', messages: [{ role: 'user', content: 'x' }] },
          new AbortController().signal,
        ),
      ),
    ).rejects.toMatchObject({ code: 'RUNTIME_INVALID_RESPONSE' });

    const streamError = new OllamaRuntime({
      target,
      config,
      fetchImpl: (async () =>
        new Response('{"error":"fallo en http://privado.local/model"}\n', {
          status: 200,
        })) as unknown as typeof fetch,
    });
    try {
      await collect(
        streamError.chat(
          { model: 'llama3', messages: [{ role: 'user', content: 'x' }] },
          new AbortController().signal,
        ),
      );
      throw new Error('Se esperaba un error');
    } catch (error) {
      expect((error as AppError).code).toBe('RUNTIME_ERROR');
      expect((error as AppError).message).toContain('[url]');
      expect((error as AppError).message).not.toContain('privado.local');
    }
  });
});
