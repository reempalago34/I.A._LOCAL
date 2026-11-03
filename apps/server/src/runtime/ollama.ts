import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { AppError } from '../utils/errors.js';
import { estimateRequirements } from './hardware.js';
import type {
  ChatMessage,
  ChatStreamChunk,
  ModelRuntime,
  RuntimeModel,
  RuntimeModelDetails,
  RuntimeStatus,
} from './types.js';
import { joinRuntimeUrl, type RuntimeTarget } from './url-policy.js';

const modelDetailsSchema = z
  .object({
    format: z.string().optional(),
    family: z.string().optional(),
    families: z.array(z.string()).optional(),
    parameter_size: z.string().optional(),
    quantization_level: z.string().optional(),
  })
  .passthrough();

const tagsSchema = z.object({
  models: z
    .array(
      z
        .object({
          name: z.string().min(1),
          size: z.number().nonnegative().default(0),
          digest: z.string().optional(),
          modified_at: z.string().optional(),
          details: modelDetailsSchema.optional(),
        })
        .passthrough(),
    )
    .default([]),
});

const showSchema = z
  .object({
    details: modelDetailsSchema.optional(),
    model_info: z.record(z.string(), z.unknown()).optional(),
    capabilities: z.array(z.string()).optional(),
  })
  .passthrough();

const versionSchema = z.object({ version: z.string() }).passthrough();

const psSchema = z
  .object({
    models: z
      .array(
        z
          .object({
            name: z.string().min(1),
            size: z.number().nonnegative().optional(),
            size_vram: z.number().nonnegative().optional(),
            context_length: z.number().nonnegative().optional(),
            expires_at: z.string().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

export interface LoadedModel {
  name: string;
  sizeBytes: number;
  sizeVramBytes: number;
  contextLength?: number;
  expiresAt?: string;
}

const chatLineSchema = z
  .object({
    message: z.object({ role: z.string().optional(), content: z.string().optional() }).optional(),
    response: z.string().optional(),
    done: z.boolean().optional(),
    error: z.string().optional(),
    prompt_eval_count: z.number().optional(),
    eval_count: z.number().optional(),
    total_duration: z.number().optional(),
  })
  .passthrough();

export interface OllamaRuntimeOptions {
  target: RuntimeTarget;
  config: AppConfig;
  fetchImpl?: typeof fetch;
}

export class OllamaRuntime implements ModelRuntime {
  readonly kind = 'ollama';
  readonly target: string;
  readonly #target: RuntimeTarget;
  readonly #config: AppConfig;
  readonly #fetch: typeof fetch;

  constructor(options: OllamaRuntimeOptions) {
    this.#target = options.target;
    this.#config = options.config;
    this.#fetch = options.fetchImpl ?? fetch;
    this.target = options.target.url;
  }

  async health(signal?: AbortSignal): Promise<RuntimeStatus> {
    try {
      const [version, models] = await Promise.all([
        this.#requestJson('/api/version', { method: 'GET' }, signal, 5_000)
          .then((data) => versionSchema.parse(data))
          .catch(() => null),
        this.listModels(signal).catch(() => null),
      ]);
      if (!version && !models) {
        return {
          reachable: false,
          error: {
            code: 'RUNTIME_OFFLINE',
            message: 'No se pudo contactar con el runtime de modelos.',
          },
        };
      }
      return {
        reachable: true,
        ...(version ? { version: version.version } : {}),
        modelCount: models?.length ?? 0,
      };
    } catch (error) {
      return { reachable: false, error: safeRuntimeError(error) };
    }
  }

  /**
   * Modelos cargados ahora mismo y cuánta memoria usan en VRAM. Permite
   * comprobar si Ollama está aprovechando una GPU sin asumirlo.
   */
  async loadedModels(signal?: AbortSignal): Promise<LoadedModel[]> {
    const data = await this.#requestJson('/api/ps', { method: 'GET' }, signal, 8_000);
    const parsed = psSchema.parse(data);
    return parsed.models.map((model) => ({
      name: model.name,
      sizeBytes: model.size ?? 0,
      sizeVramBytes: model.size_vram ?? 0,
      ...(model.context_length ? { contextLength: model.context_length } : {}),
      ...(model.expires_at ? { expiresAt: model.expires_at } : {}),
    }));
  }

  async listModels(signal?: AbortSignal): Promise<RuntimeModel[]> {
    const data = await this.#requestJson('/api/tags', { method: 'GET' }, signal, 10_000);
    const parsed = tagsSchema.parse(data);
    return parsed.models
      .map((model) => {
        const details: RuntimeModelDetails = {
          format: model.details?.format,
          family: model.details?.family,
          families: model.details?.families,
          parameterSize: model.details?.parameter_size,
          quantizationLevel: model.details?.quantization_level,
        };
        return {
          name: model.name,
          sizeBytes: model.size,
          digest: model.digest,
          modifiedAt: model.modified_at,
          details,
          capabilities: {},
          requirements: estimateRequirements({
            sizeBytes: model.size,
            parameterSize: details.parameterSize,
            quantizationLevel: details.quantizationLevel,
          }),
        } satisfies RuntimeModel;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getModel(name: string, signal?: AbortSignal): Promise<RuntimeModel> {
    const models = await this.listModels(signal);
    const found = models.find((model) => model.name === name);
    let show: z.infer<typeof showSchema> | null = null;
    try {
      const data = await this.#requestJson(
        '/api/show',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: name }),
        },
        signal,
        10_000,
      );
      show = showSchema.parse(data);
    } catch (error) {
      if (!found) throw error;
    }
    if (!found && !show) {
      throw new AppError(404, 'MODEL_NOT_FOUND', 'El modelo no existe en el runtime.');
    }
    const info = show?.model_info ?? {};
    const contextLength = pickContextLength(info);
    const parameterCount = pickParameterCount(info);
    const details: RuntimeModelDetails = {
      ...(found?.details ?? {}),
      ...(show?.details
        ? {
            format: show.details.format ?? found?.details.format,
            family: show.details.family ?? found?.details.family,
            families: show.details.families ?? found?.details.families,
            parameterSize: show.details.parameter_size ?? found?.details.parameterSize,
            quantizationLevel: show.details.quantization_level ?? found?.details.quantizationLevel,
          }
        : {}),
    };
    const sizeBytes = found?.sizeBytes ?? 0;
    return {
      name,
      sizeBytes,
      digest: found?.digest,
      modifiedAt: found?.modifiedAt,
      details,
      capabilities: {
        contextLength,
        parameterCount,
        capabilities: show?.capabilities,
      },
      requirements: estimateRequirements({
        sizeBytes,
        parameterCount,
        parameterSize: details.parameterSize,
        quantizationLevel: details.quantizationLevel,
        contextLength,
      }),
    };
  }

  async *chat(
    request: { model: string; messages: ChatMessage[] },
    signal: AbortSignal,
  ): AsyncGenerator<ChatStreamChunk, void, unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const abortFromOuter = () => controller.abort(signal.reason);
    if (signal.aborted) {
      throw new AppError(499, 'GENERATION_CANCELLED', 'Generación cancelada.');
    }
    signal.addEventListener('abort', abortFromOuter, { once: true });

    let idleTimer: NodeJS.Timeout | null = null;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error('runtime idle timeout'));
      }, this.#config.runtimeStreamIdleTimeoutMs);
    };

    try {
      resetIdle();
      const response = await this.#fetch(joinRuntimeUrl(this.#target.url, '/api/chat'), {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        await this.#throwHttpError(response, 'chat');
      }
      if (!response.body) {
        throw new AppError(
          502,
          'RUNTIME_INVALID_RESPONSE',
          'El runtime devolvió una respuesta vacía.',
        );
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;

      while (!finished) {
        resetIdle();
        let read: Awaited<ReturnType<typeof reader.read>>;
        try {
          read = await reader.read();
        } catch (error) {
          if (timedOut) {
            throw new AppError(
              504,
              'RUNTIME_TIMEOUT',
              'El runtime dejó de responder durante la generación.',
            );
          }
          if (signal.aborted) {
            throw new AppError(499, 'GENERATION_CANCELLED', 'Generación cancelada.');
          }
          throw mapFetchError(error);
        }
        if (read.done) break;
        buffer += decoder.decode(read.value, { stream: true });
        if (buffer.length > 2_000_000) {
          throw new AppError(
            502,
            'RUNTIME_INVALID_RESPONSE',
            'El runtime devolvió una respuesta demasiado grande.',
          );
        }
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            let parsedJson: unknown;
            try {
              parsedJson = JSON.parse(line);
            } catch {
              throw new AppError(
                502,
                'RUNTIME_INVALID_RESPONSE',
                'El runtime devolvió datos que no se pudieron interpretar.',
              );
            }
            const parsed = chatLineSchema.parse(parsedJson);
            if (parsed.error) {
              throw new AppError(502, 'RUNTIME_ERROR', sanitizeRuntimeMessage(parsed.error));
            }
            const text = parsed.message?.content ?? parsed.response ?? '';
            if (text) yield { type: 'delta', text };
            if (parsed.done) {
              finished = true;
              yield {
                type: 'done',
                usage: {
                  promptTokens: parsed.prompt_eval_count,
                  completionTokens: parsed.eval_count,
                  totalDurationMs: parsed.total_duration
                    ? Math.round(parsed.total_duration / 1_000_000)
                    : undefined,
                },
              };
              break;
            }
          }
          newline = buffer.indexOf('\n');
        }
      }

      if (buffer.trim()) {
        try {
          const parsed = chatLineSchema.parse(JSON.parse(buffer.trim()));
          const text = parsed.message?.content ?? parsed.response ?? '';
          if (text) yield { type: 'delta', text };
          if (parsed.done) {
            yield {
              type: 'done',
              usage: {
                promptTokens: parsed.prompt_eval_count,
                completionTokens: parsed.eval_count,
                totalDurationMs: parsed.total_duration
                  ? Math.round(parsed.total_duration / 1_000_000)
                  : undefined,
              },
            };
          }
        } catch {
          // Un último fragmento incompleto se ignora de forma segura.
        }
      }
    } catch (error) {
      if (signal.aborted) {
        throw new AppError(499, 'GENERATION_CANCELLED', 'Generación cancelada.');
      }
      if (timedOut) {
        throw new AppError(
          504,
          'RUNTIME_TIMEOUT',
          'El runtime dejó de responder durante la generación.',
        );
      }
      throw error;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      signal.removeEventListener('abort', abortFromOuter);
    }
  }

  async #requestJson(
    pathname: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await this.#fetch(joinRuntimeUrl(this.#target.url, pathname), {
        ...init,
        headers: { ...this.#headers(), ...(init.headers ?? {}) },
        signal: controller.signal,
      });
      if (!response.ok) {
        await this.#throwHttpError(response, pathname);
      }
      try {
        return (await response.json()) as unknown;
      } catch {
        throw new AppError(
          502,
          'RUNTIME_INVALID_RESPONSE',
          'El runtime devolvió una respuesta que no es JSON válido.',
        );
      }
    } catch (error) {
      if (timedOut) {
        throw new AppError(504, 'RUNTIME_TIMEOUT', 'El runtime tardó demasiado en responder.');
      }
      if (signal?.aborted) {
        throw new AppError(499, 'GENERATION_CANCELLED', 'Solicitud cancelada.');
      }
      throw mapFetchError(error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async #throwHttpError(response: Response, context: string): Promise<never> {
    let detail = '';
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === 'string') detail = body.error;
    } catch {
      // sin cuerpo legible
    }
    if (response.status === 404) {
      throw new AppError(
        404,
        'MODEL_NOT_FOUND',
        'El modelo solicitado no existe en el runtime. Actualiza la lista de modelos.',
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new AppError(
        502,
        'RUNTIME_UNAUTHORIZED',
        'El runtime rechazó la autenticación. Revisa el token configurado en el servidor.',
      );
    }
    if (response.status === 429) {
      throw new AppError(
        429,
        'RUNTIME_BUSY',
        'El runtime está ocupado o limitando solicitudes. Inténtalo de nuevo.',
      );
    }
    throw new AppError(
      502,
      'RUNTIME_HTTP_ERROR',
      detail
        ? sanitizeRuntimeMessage(detail)
        : context === 'chat'
          ? 'El runtime no pudo procesar la conversación.'
          : 'El runtime devolvió un error.',
      { details: { status: response.status } },
    );
  }

  #headers(): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.#config.runtimeAuthToken) {
      headers.authorization = `Bearer ${this.#config.runtimeAuthToken}`;
    }
    return headers;
  }
}

function mapFetchError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const cause = (error as { cause?: { code?: string } })?.cause;
  const code = cause?.code ?? (error as { code?: string })?.code;
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE') {
    return new AppError(
      503,
      'RUNTIME_OFFLINE',
      'No se puede conectar con el runtime. Comprueba la dirección y que Ollama esté en marcha.',
    );
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new AppError(
      503,
      'RUNTIME_DNS_ERROR',
      'No se pudo resolver el nombre del runtime. Revisa la red o la dirección configurada.',
    );
  }
  if (
    code === 'CERT_HAS_EXPIRED' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
  ) {
    return new AppError(
      502,
      'RUNTIME_TLS_ERROR',
      'La conexión TLS con el runtime no es válida. Revisa el certificado.',
    );
  }
  if ((error as Error)?.name === 'AbortError') {
    return new AppError(499, 'GENERATION_CANCELLED', 'Solicitud cancelada.');
  }
  return new AppError(
    503,
    'RUNTIME_UNREACHABLE',
    'No se pudo contactar con el runtime de modelos.',
  );
}

function safeRuntimeError(error: unknown): { code: string; message: string } {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  return {
    code: 'RUNTIME_UNREACHABLE',
    message: 'No se pudo contactar con el runtime de modelos.',
  };
}

function sanitizeRuntimeMessage(message: string): string {
  return message
    .replace(/\/[\w./-]+\/(?:api|models)\/[^\s]*/g, '[ruta]')
    .replace(/\b(?:https?:\/\/)[^\s]+/gi, '[url]')
    .slice(0, 300);
}

function pickContextLength(info: Record<string, unknown>): number | undefined {
  for (const [key, value] of Object.entries(info)) {
    if (key.endsWith('.context_length') && typeof value === 'number' && value > 0) {
      return value;
    }
  }
  return undefined;
}

function pickParameterCount(info: Record<string, unknown>): number | undefined {
  const value = info['general.parameter_count'];
  return typeof value === 'number' && value > 0 ? value : undefined;
}
