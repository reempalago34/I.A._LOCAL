import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/hooks.js';
import type { AppConfig } from '../config.js';
import { estimateTokens } from '../files/context.js';
import type { ProposalService } from '../proposals/service.js';
import { OllamaRuntime } from '../runtime/ollama.js';
import { resolveRuntimeTarget } from '../runtime/url-policy.js';
import type { SettingsService } from '../settings/service.js';
import { AppError, toPublicError } from '../utils/errors.js';
import { parseAssistantOutput, validateCommandText } from './parser.js';
import type { ChatService } from './service.js';

export function registerChatRoutes(
  app: FastifyInstance,
  options: {
    config: AppConfig;
    chat: ChatService;
    proposals: ProposalService;
    settings: SettingsService;
  },
): void {
  const { config, chat, proposals, settings } = options;

  const bodySchema = z.object({
    message: z.string().trim().min(1, 'Escribe un mensaje.').max(config.maxMessageChars),
    model: z.string().max(200).optional(),
    conversationId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
    runtimeUrl: z.string().url().max(2048).optional(),
    contextPaths: z
      .array(z.string().max(1024))
      .max(config.maxContextFiles * 2)
      .optional(),
    confirmRemoteContext: z.boolean().optional(),
    history: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string().max(120_000),
        }),
      )
      .max(60)
      .optional(),
  });

  app.post('/api/chat', async (request, reply) => {
    const { user } = requireAuth(request);
    const body = bodySchema.parse(request.body);
    const access = chat.acquire(user.id);

    let prepared: Awaited<ReturnType<ChatService['prepare']>>;
    try {
      prepared = await chat.prepare(user, { ...body, model: body.model ?? '' });
    } catch (error) {
      access.release();
      throw error;
    }

    if (reply.raw.destroyed) {
      access.release();
      return;
    }

    const { release, controller } = access;
    let completed = false;
    let heartbeat: NodeJS.Timeout | null = null;
    let clientGone = false;
    const abort = () => {
      if (completed) return;
      clientGone = true;
      controller.abort(new Error('client disconnected'));
    };
    request.raw.on('aborted', abort);
    reply.raw.on('close', () => {
      if (!completed) abort();
    });

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    reply.raw.flushHeaders();

    const send = (event: string, data: unknown): void => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    heartbeat = setInterval(() => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.write(': keepalive\n\n');
      }
    }, 15_000);
    heartbeat.unref();

    send('meta', {
      generationId: prepared.generationId,
      conversationId: prepared.conversation?.id ?? null,
      userMessageId: prepared.userMessageId,
      model: prepared.model,
      runtime: {
        host: `${prepared.target.hostname}:${prepared.target.port}`,
        location: prepared.runtimeLocation,
        isLocal: prepared.target.isLocal,
        numCtx: config.runtimeNumCtx,
        executionScope:
          config.deploymentMode === 'server'
            ? 'remote-server'
            : prepared.target.isLocal
              ? 'this-computer'
              : 'remote-server',
      },
      context: prepared.context
        ? {
            files: prepared.context.files.map((file) => ({
              path: file.path,
              bytes: file.bytes,
            })),
            totalBytes: prepared.context.totalBytes,
            estimatedTokens: prepared.context.estimatedTokens,
          }
        : null,
      persisted: prepared.persisted,
    });

    const estimatedPromptTokens = estimateTokens(
      prepared.messages.map((message) => message.content).join('\n'),
    );
    const windowWarnings: string[] = [];
    if (estimatedPromptTokens > config.runtimeNumCtx) {
      windowWarnings.push(
        `El prompt estimado (~${estimatedPromptTokens} tokens) supera la ventana de contexto configurada (${config.runtimeNumCtx} tokens). Ollama podría truncar contenido. Quita archivos, acorta el historial o aumenta RUNTIME_NUM_CTX.`,
      );
    }

    let raw = '';
    let usage: {
      promptTokens?: number;
      completionTokens?: number;
      totalDurationMs?: number;
      doneReason?: string;
    } = {};

    try {
      for await (const chunk of prepared.runtime.chat(
        { model: prepared.model, messages: prepared.messages },
        controller.signal,
      )) {
        if (chunk.type === 'delta') {
          raw += chunk.text;
          send('delta', { text: chunk.text });
        } else if (chunk.type === 'done') {
          usage = chunk.usage;
        }
      }

      const parsed = parseAssistantOutput(raw);
      const created = prepared.project
        ? await proposals.createFromParsed({
            userId: user.id,
            project: prepared.project,
            parsed: parsed.proposals,
          })
        : {
            proposals: [],
            warnings:
              parsed.proposals.length > 0
                ? ['Selecciona un proyecto para poder revisar y aplicar los cambios propuestos.']
                : [],
            skipped: 0,
          };

      const commandResults = parsed.commands.map((command) => {
        const validation = validateCommandText(command.command);
        const binary = validation.argv?.[0];
        const allowed =
          validation.ok &&
          Boolean(binary) &&
          !binary!.includes('/') &&
          !binary!.includes('\\') &&
          config.commandAllowlist.includes(binary!);
        return {
          command: command.command,
          allowed,
          enabled: config.enableCommandExecution,
          reason: validation.reason,
          effects:
            'Se ejecutaría dentro de la carpeta del proyecto con un entorno mínimo. Revisa el comando antes de aprobarlo.',
        };
      });

      const warnings = [...windowWarnings, ...parsed.warnings, ...created.warnings];
      const nearWindow =
        typeof usage.promptTokens === 'number' &&
        usage.promptTokens >= Math.ceil(config.runtimeNumCtx * 0.95);
      if (nearWindow && windowWarnings.length === 0) {
        warnings.push(
          `Ollama procesó ${usage.promptTokens} tokens de prompt, cerca del límite de la ventana (${config.runtimeNumCtx} tokens). Es posible que haya truncado archivos del contexto; quita archivos o aumenta RUNTIME_NUM_CTX.`,
        );
      }
      if (usage.doneReason === 'length') {
        warnings.push(
          'La respuesta se cortó por el límite de tokens de salida del runtime. Pide una respuesta más breve o continúa en otro mensaje.',
        );
      }
      if (created.proposals.length > 0) {
        send('proposals', {
          proposals: created.proposals,
          warnings,
          projectId: prepared.project?.id ?? null,
        });
      }
      if (commandResults.length > 0) {
        send('commands', {
          commands: commandResults,
          projectId: prepared.project?.id ?? null,
        });
      }
      if (warnings.length > 0) send('warnings', { warnings });

      const finalized = await chat.finalize({
        prepared,
        displayContent: parsed.displayContent || raw,
        rawContent: raw,
        proposals: created.proposals,
        commands: commandResults,
        warnings,
        usage,
      });

      completed = true;
      send('done', {
        generationId: prepared.generationId,
        conversationId: prepared.conversation?.id ?? null,
        assistantMessageId: finalized.messageId,
        usage,
        persisted: finalized.persisted,
      });
    } catch (error) {
      if (!clientGone && !completed) {
        send('error', toPublicError(error, request.id).error);
        if (!(error instanceof AppError)) {
          request.log.error({ err: error, requestId: request.id }, 'Error de generación');
        }
      }
    } finally {
      completed = true;
      if (heartbeat) clearInterval(heartbeat);
      chat.dispose(prepared);
      release();
      if (!reply.raw.writableEnded && !reply.raw.destroyed) {
        reply.raw.end();
      }
    }
  });

  app.get('/api/runtime/status', async (request) => {
    const { user } = requireAuth(request);
    const query = z
      .object({ runtimeUrl: z.string().url().max(2048).optional() })
      .parse(request.query ?? {});
    const userSettings = settings.get(user.id);
    const target = resolveRuntimeTarget(query.runtimeUrl ?? userSettings.runtimeUrl, config);
    const runtime = new OllamaRuntime({ target, config });
    const status = await runtime.health(AbortSignal.timeout(8_000));
    return {
      ...status,
      runtime: {
        host: `${target.hostname}:${target.port}`,
        location: target.location,
        isLocal: target.isLocal,
        executionScope:
          config.deploymentMode === 'server'
            ? 'remote-server'
            : target.isLocal
              ? 'this-computer'
              : 'remote-server',
      },
    };
  });

  app.get('/api/runtime/models', async (request) => {
    const { user } = requireAuth(request);
    const query = z
      .object({ runtimeUrl: z.string().url().max(2048).optional() })
      .parse(request.query ?? {});
    const userSettings = settings.get(user.id);
    const target = resolveRuntimeTarget(query.runtimeUrl ?? userSettings.runtimeUrl, config);
    const runtime = new OllamaRuntime({ target, config });
    const models = await runtime.listModels(AbortSignal.timeout(15_000));
    return {
      models,
      runtime: {
        host: `${target.hostname}:${target.port}`,
        location: target.location,
        isLocal: target.isLocal,
        executionScope:
          config.deploymentMode === 'server'
            ? 'remote-server'
            : target.isLocal
              ? 'this-computer'
              : 'remote-server',
      },
    };
  });

  app.get('/api/runtime/model', async (request) => {
    const { user } = requireAuth(request);
    const query = z
      .object({
        name: z.string().min(1).max(200),
        runtimeUrl: z.string().url().max(2048).optional(),
      })
      .parse(request.query ?? {});
    const userSettings = settings.get(user.id);
    const target = resolveRuntimeTarget(query.runtimeUrl ?? userSettings.runtimeUrl, config);
    const runtime = new OllamaRuntime({ target, config });
    return { model: await runtime.getModel(query.name, AbortSignal.timeout(15_000)) };
  });
}
