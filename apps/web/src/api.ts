export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly requestId?: string;

  constructor(
    status: number,
    body: {
      code?: string;
      message?: string;
      details?: Record<string, unknown>;
      requestId?: string;
    },
  ) {
    super(body.message ?? 'La solicitud falló.');
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code ?? 'UNKNOWN_ERROR';
    this.details = body.details;
    this.requestId = body.requestId;
  }
}

let csrfToken = '';

export function setCsrfToken(token: string): void {
  csrfToken = token;
}

export function getCsrfToken(): string {
  return csrfToken;
}

export interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
    requestId?: string;
  };
}

async function parseError(response: Response): Promise<ApiError> {
  let body: ApiErrorBody = {};
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    // Respuesta sin JSON legible.
  }
  return new ApiError(response.status, {
    code: body.error?.code,
    message: body.error?.message ?? `Error HTTP ${response.status}.`,
    details: body.error?.details,
    requestId: body.error?.requestId,
  });
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  if (method !== 'GET' && method !== 'HEAD' && csrfToken) {
    headers.set('x-csrf-token', csrfToken);
  }
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      method,
      headers,
      credentials: 'include',
    });
  } catch {
    throw new ApiError(0, {
      code: 'NETWORK_ERROR',
      message: 'No se pudo contactar con el servidor. Revisa tu conexión.',
    });
  }
  if (response.status === 401) {
    window.dispatchEvent(
      new CustomEvent('forge:unauthorized', { detail: { path: path.split('?')[0] } }),
    );
  }
  if (!response.ok) {
    throw await parseError(response);
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export async function ensureCsrf(): Promise<string> {
  if (csrfToken) return csrfToken;
  const data = await api<{ csrfToken: string }>('/api/auth/csrf');
  setCsrfToken(data.csrfToken);
  return csrfToken;
}

export interface SseEvent {
  event: string;
  data: unknown;
}

export function createSseParser(onEvent: (event: SseEvent) => void): {
  push: (chunk: string) => void;
  flush: () => void;
} {
  let buffer = '';
  const emit = (block: string) => {
    let event = 'message';
    const dataLines: string[] = [];
    for (const rawLine of block.split('\n')) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line || line.startsWith(':')) continue;
      const separator = line.indexOf(':');
      const field = separator >= 0 ? line.slice(0, separator) : line;
      const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, '') : '';
      if (field === 'event') event = value;
      else if (field === 'data') dataLines.push(value);
    }
    if (dataLines.length === 0) return;
    const raw = dataLines.join('\n');
    let data: unknown = raw;
    try {
      data = JSON.parse(raw) as unknown;
    } catch {
      // Se entrega el texto tal cual.
    }
    onEvent({ event, data });
  };

  return {
    push(chunk: string) {
      buffer += chunk.replace(/\r\n/g, '\n');
      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        emit(block);
        index = buffer.indexOf('\n\n');
      }
    },
    flush() {
      if (buffer.trim()) emit(buffer);
      buffer = '';
    },
  };
}

export async function readSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: SseEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser(onEvent);
  try {
    while (true) {
      if (signal?.aborted) throw new ApiError(499, { code: 'CANCELLED', message: 'Cancelado.' });
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.flush();
  } finally {
    reader.releaseLock();
  }
}

export interface StreamChatOptions {
  body: Record<string, unknown>;
  signal: AbortSignal;
  onEvent: (event: SseEvent) => void;
}

export async function streamChat(options: StreamChatOptions): Promise<void> {
  await ensureCsrf();
  const headers = new Headers({
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'x-csrf-token': csrfToken,
  });
  let response: Response;
  try {
    response = await fetch('/api/chat', {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal.aborted) {
      throw new ApiError(499, { code: 'CANCELLED', message: 'Generación cancelada.' });
    }
    throw error;
  }
  if (!response.ok) {
    throw await parseError(response);
  }
  if (!response.body) {
    throw new ApiError(502, {
      code: 'EMPTY_STREAM',
      message: 'El servidor devolvió una respuesta vacía.',
    });
  }
  await readSse(response.body, options.onEvent, options.signal);
}
