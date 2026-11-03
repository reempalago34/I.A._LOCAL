import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  api,
  createSseParser,
  getCsrfToken,
  readSse,
  type SseEvent,
  setCsrfToken,
  streamChat,
} from './api';

afterEach(() => {
  vi.unstubAllGlobals();
  setCsrfToken('');
});

describe('createSseParser', () => {
  it('ensambla eventos partidos entre chunks', () => {
    const events: SseEvent[] = [];
    const parser = createSseParser((event) => events.push(event));
    parser.push('event: delta\ndata: {"text":"Ho');
    parser.push('la"}\n\nevent: done\ndata: {"ok":true}\n\n');
    expect(events).toEqual([
      { event: 'delta', data: { text: 'Hola' } },
      { event: 'done', data: { ok: true } },
    ]);
  });

  it('soporta CRLF, comentarios, data multilínea y texto no JSON', () => {
    const events: SseEvent[] = [];
    const parser = createSseParser((event) => events.push(event));
    parser.push(': keepalive\r\n\r\n');
    parser.push('event: meta\r\ndata: {"a":1}\r\n\r\n');
    parser.push('data: linea1\ndata: linea2\n\n');
    parser.flush();
    expect(events).toEqual([
      { event: 'meta', data: { a: 1 } },
      { event: 'message', data: 'linea1\nlinea2' },
    ]);
  });

  it('emite el resto al hacer flush y descarta bloques sin data', () => {
    const events: SseEvent[] = [];
    const parser = createSseParser((event) => events.push(event));
    parser.push('event: sin-data\n\n');
    parser.push('data: final');
    parser.flush();
    expect(events).toEqual([{ event: 'message', data: 'final' }]);
  });
});

describe('api', () => {
  it('adjunta CSRF solo en métodos inseguros y parsea JSON', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('x-csrf-token')).toBe('csrf-123');
      expect(headers.get('content-type')).toBe('application/json');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    setCsrfToken('csrf-123');

    await expect(
      api<{ ok: boolean }>('/api/test', { method: 'POST', body: '{}' }),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getCsrfToken()).toBe('csrf-123');
  });

  it('no adjunta CSRF en GET y maneja respuestas 204 y vacías', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('x-csrf-token')).toBeNull();
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetchMock);
    setCsrfToken('csrf-123');
    await expect(api('/api/test')).resolves.toBeUndefined();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 200 })),
    );
    await expect(api('/api/empty')).resolves.toBeUndefined();
  });

  it('convierte errores HTTP en ApiError con código y requestId', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: 'FORBIDDEN',
                message: 'No permitido',
                details: { reason: 'csrf' },
                requestId: 'req-9',
              },
            }),
            { status: 403 },
          ),
      ),
    );
    const promise = api('/api/test', { method: 'POST' });
    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await expect(promise).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
      message: 'No permitido',
      details: { reason: 'csrf' },
      requestId: 'req-9',
    });
  });

  it('genera un ApiError genérico si el cuerpo de error no es JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 502 })),
    );
    await expect(api('/api/test')).rejects.toMatchObject({
      status: 502,
      code: 'UNKNOWN_ERROR',
      message: 'Error HTTP 502.',
    });
  });

  it('convierte fallos de red en NETWORK_ERROR', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(api('/api/test')).rejects.toMatchObject({
      status: 0,
      code: 'NETWORK_ERROR',
    });
  });

  it('emite un evento al recibir 401', async () => {
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    const listener = vi.fn();
    target.addEventListener('forge:unauthorized', listener);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'No' } }), {
            status: 401,
          }),
      ),
    );
    await expect(api('/api/private?x=1')).rejects.toMatchObject({ status: 401 });
    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0]?.[0] as CustomEvent | undefined;
    expect(event?.detail).toEqual({ path: '/api/private' });
  });
});

describe('streamChat', () => {
  it('envía el cuerpo y entrega eventos SSE', async () => {
    setCsrfToken('csrf-stream');
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(init?.body).toBe(JSON.stringify({ message: 'Hola' }));
      const headers = new Headers(init?.headers);
      expect(headers.get('x-csrf-token')).toBe('csrf-stream');
      expect(headers.get('accept')).toBe('text/event-stream');
      return new Response('event: delta\ndata: {"text":"Hola"}\n\nevent: done\ndata: {}\n\n', {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const events: SseEvent[] = [];
    await streamChat({
      body: { message: 'Hola' },
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    });
    expect(events.map((event) => event.event)).toEqual(['delta', 'done']);
  });

  it('traduce la cancelación y los errores del servidor', async () => {
    setCsrfToken('csrf-stream');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 'RATE_LIMITED' } }), {
            status: 429,
          }),
      ),
    );
    await expect(
      streamChat({ body: {}, signal: new AbortController().signal, onEvent: () => undefined }),
    ).rejects.toMatchObject({ status: 429, code: 'RATE_LIMITED' });

    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('Aborted', 'AbortError');
      }),
    );
    await expect(
      streamChat({ body: {}, signal: controller.signal, onEvent: () => undefined }),
    ).rejects.toMatchObject({ status: 499, code: 'CANCELLED' });
  });

  it('rechaza respuestas sin cuerpo de stream', async () => {
    setCsrfToken('csrf-stream');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    await expect(
      streamChat({ body: {}, signal: new AbortController().signal, onEvent: () => undefined }),
    ).rejects.toMatchObject({ status: 502, code: 'EMPTY_STREAM' });
  });
});

describe('readSse', () => {
  it('decodifica UTF-8 dividido entre chunks y cancela si se aborta', async () => {
    const encoder = new TextEncoder();
    const chunks = [encoder.encode('event: delta\ndata: {"text":"caf'), encoder.encode('é"}\n\n')];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const events: SseEvent[] = [];
    await readSse(stream, (event) => events.push(event));
    expect(events).toEqual([{ event: 'delta', data: { text: 'café' } }]);

    const controller = new AbortController();
    controller.abort();
    await expect(
      readSse(new ReadableStream<Uint8Array>(), () => undefined, controller.signal),
    ).rejects.toMatchObject({ status: 499, code: 'CANCELLED' });
  });
});
