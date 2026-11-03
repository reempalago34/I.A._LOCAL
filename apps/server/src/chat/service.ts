import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { Store } from '../db.js';
import { type BuiltContext, buildContext, limitsFromSettings } from '../files/context.js';
import type { FileSandbox } from '../files/sandbox.js';
import { OllamaRuntime } from '../runtime/ollama.js';
import type { ModelRuntime } from '../runtime/types.js';
import {
  type RuntimeLocation,
  type RuntimeTarget,
  resolveRuntimeTarget,
} from '../runtime/url-policy.js';
import type { SettingsService } from '../settings/service.js';
import type { StorageService } from '../storage/service.js';
import type { ConversationRecord, ProjectRecord, UserRecord } from '../types.js';
import { AppError, tooManyRequests } from '../utils/errors.js';
import { buildChatMessages, buildSystemPrompt, limitHistory } from './prompt.js';

export interface ChatHistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatInput {
  message: string;
  model: string;
  conversationId?: string;
  projectId?: string;
  runtimeUrl?: string;
  contextPaths?: string[];
  confirmRemoteContext?: boolean;
  history?: ChatHistoryItem[];
}

export interface PreparedChat {
  generationId: string;
  runtime: ModelRuntime;
  target: RuntimeTarget;
  model: string;
  conversation: ConversationRecord | null;
  project: ProjectRecord | null;
  context: BuiltContext | null;
  messages: ReturnType<typeof buildChatMessages>;
  userMessageId: string | null;
  runtimeLocation: RuntimeLocation;
  persisted: boolean;
}

export interface FinalizeInput {
  prepared: PreparedChat;
  displayContent: string;
  rawContent: string;
  proposals: unknown[];
  commands: unknown[];
  warnings: string[];
  usage: { promptTokens?: number; completionTokens?: number; totalDurationMs?: number };
}

export class ChatService {
  #active = new Map<string, AbortController>();
  #requestTimes = new Map<string, number[]>();

  readonly #runtimeFactory: (target: RuntimeTarget) => ModelRuntime;

  constructor(
    private readonly store: Store,
    private readonly config: AppConfig,
    private readonly settings: SettingsService,
    private readonly sandbox: FileSandbox,
    private readonly storage: StorageService,
    runtimeFactory?: (target: RuntimeTarget) => ModelRuntime,
  ) {
    this.#runtimeFactory =
      runtimeFactory ?? ((target) => new OllamaRuntime({ target, config: this.config }));
  }

  async prepare(user: UserRecord, input: ChatInput): Promise<PreparedChat> {
    const userSettings = this.settings.get(user.id);
    const model = (input.model || userSettings.defaultModel).trim();
    if (!model) {
      throw new AppError(
        400,
        'MODEL_REQUIRED',
        'Selecciona un modelo de la lista antes de enviar la consulta.',
      );
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,199}$/.test(model)) {
      throw new AppError(400, 'INVALID_MODEL', 'El nombre del modelo no es válido.');
    }

    const target = resolveRuntimeTarget(input.runtimeUrl ?? userSettings.runtimeUrl, this.config);
    const runtime = this.#runtimeFactory(target);

    let conversation: ConversationRecord | null = null;
    if (input.conversationId) {
      if (!userSettings.persistHistory) {
        throw new AppError(
          409,
          'HISTORY_DISABLED',
          'El historial persistente está desactivado. Inicia una conversación nueva.',
        );
      }
      conversation = this.store.findConversation(user.id, input.conversationId);
      if (!conversation) {
        throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'La conversación no existe.');
      }
    }

    const projectId = input.projectId ?? conversation?.projectId ?? undefined;
    let project: ProjectRecord | null = null;
    if (projectId) {
      project = this.store.findProject(user.id, projectId);
      if (!project) {
        throw new AppError(404, 'PROJECT_NOT_FOUND', 'El proyecto no existe o no te pertenece.');
      }
    }

    const contextPaths = [...new Set(input.contextPaths ?? [])].filter(Boolean);
    if (contextPaths.length > 0 && !project) {
      throw new AppError(
        400,
        'PROJECT_REQUIRED',
        'Selecciona un proyecto antes de adjuntar archivos al contexto.',
      );
    }
    let context: BuiltContext | null = null;
    if (project && contextPaths.length > 0) {
      context = await buildContext({
        sandbox: this.sandbox,
        project,
        paths: contextPaths,
        limits: limitsFromSettings(userSettings),
      });
    }

    if (!target.isLocal && context && context.files.length > 0 && !input.confirmRemoteContext) {
      throw new AppError(
        409,
        'CONTEXT_AUTHORIZATION_REQUIRED',
        'El runtime está fuera de este servidor. Confirma explícitamente el envío de archivos antes de continuar.',
        {
          details: {
            runtimeHost: `${target.hostname}:${target.port}`,
            runtimeLocation: target.location,
            files: context.files.map((file) => ({ path: file.path, bytes: file.bytes })),
            totalBytes: context.totalBytes,
            estimatedTokens: context.estimatedTokens,
          },
        },
      );
    }

    let history: ChatHistoryItem[] = [];
    if (conversation) {
      history = this.store
        .listRecentMessages(conversation.id, 40)
        .map((item) => ({ role: item.role, content: item.content }));
    } else {
      history = limitHistory(input.history ?? []);
    }

    const messages = buildChatMessages({
      systemPrompt: buildSystemPrompt(project?.name),
      history,
      userMessage: input.message,
      ...(context
        ? {
            context: {
              projectName: project?.name ?? 'proyecto',
              formatted: context.formatted,
              files: context.files.map((file) => file.path),
            },
          }
        : {}),
    });

    let userMessageId: string | null = null;
    let persisted = false;
    if (userSettings.persistHistory) {
      // Se comprueba antes de escribir: el límite incluye conversaciones y backups.
      await this.storage.assertWithinLimit(
        user.id,
        Buffer.byteLength(input.message, 'utf8') + 2_048,
      );
      const activeConversation =
        conversation ??
        this.store.createConversation({
          id: randomUUID(),
          userId: user.id,
          projectId: project?.id ?? null,
          title: makeTitle(input.message),
          model,
          now: Date.now(),
        });
      conversation = activeConversation;
      userMessageId = randomUUID();
      this.store.createMessage({
        id: userMessageId,
        conversationId: activeConversation.id,
        role: 'user',
        content: input.message,
        model,
        metadata: {
          projectId: project?.id ?? null,
          contextPaths: context?.files.map((file) => file.path) ?? [],
          runtimeLocation: target.location,
        },
        now: Date.now(),
      });
      this.store.updateConversation(
        user.id,
        activeConversation.id,
        { model, projectId: project?.id ?? null },
        Date.now(),
      );
      persisted = true;
    }

    return {
      generationId: randomUUID(),
      runtime,
      target,
      model,
      conversation,
      project,
      context,
      messages,
      userMessageId,
      runtimeLocation: target.location,
      persisted,
    };
  }

  acquire(userId: string): { release: () => void; controller: AbortController } {
    const now = Date.now();
    const windowStart = now - 60_000;
    const times = (this.#requestTimes.get(userId) ?? []).filter((time) => time > windowStart);
    if (times.length >= this.config.chatRateLimitPerMinute) {
      throw tooManyRequests(
        'Has alcanzado el límite de generaciones por minuto. Espera antes de reintentar.',
        60,
      );
    }
    if (this.#active.has(userId)) {
      throw tooManyRequests('Ya hay una generación activa. Cancélala o espera a que termine.', 5);
    }
    times.push(now);
    this.#requestTimes.set(userId, times);
    const controller = new AbortController();
    this.#active.set(userId, controller);
    return {
      controller,
      release: () => {
        if (this.#active.get(userId) === controller) {
          this.#active.delete(userId);
        }
      },
    };
  }

  get activeControllers(): AbortController[] {
    return [...this.#active.values()];
  }

  async finalize(input: FinalizeInput): Promise<{ messageId: string | null; persisted: boolean }> {
    if (!input.prepared.persisted || !input.prepared.conversation) {
      return { messageId: null, persisted: false };
    }
    const estimatedBytes =
      Buffer.byteLength(input.displayContent, 'utf8') +
      Buffer.byteLength(JSON.stringify(input.usage), 'utf8') +
      4_096;
    const usage = await this.storage.usage(input.prepared.conversation.userId);
    if (
      usage.trackedBytes + estimatedBytes > usage.limitBytes ||
      (usage.dataDir.freeBytes > 0 && usage.dataDir.freeBytes < estimatedBytes + 32 * 1024 ** 2)
    ) {
      return { messageId: null, persisted: false };
    }
    const messageId = randomUUID();
    this.store.createMessage({
      id: messageId,
      conversationId: input.prepared.conversation.id,
      role: 'assistant',
      content: input.displayContent,
      model: input.prepared.model,
      metadata: {
        proposals: input.proposals.map((proposal) => summarizeProposal(proposal)),
        commands: input.commands,
        warnings: input.warnings,
        usage: input.usage,
        runtimeLocation: input.prepared.runtimeLocation,
        contextFiles: input.prepared.context?.files.map((file) => file.path) ?? [],
        rawContentStored: false,
      },
      now: Date.now(),
    });
    if (input.prepared.project) this.store.touchProject(input.prepared.project.id, Date.now());
    this.store.updateConversation(
      input.prepared.conversation.userId,
      input.prepared.conversation.id,
      { model: input.prepared.model },
      Date.now(),
    );
    return { messageId, persisted: true };
  }

  /**
   * Libera las referencias al contexto y a los mensajes en cuanto termina la
   * generación. Evita que archivos grandes sigan retenidos en memoria.
   */
  dispose(prepared: PreparedChat): void {
    prepared.context = null;
    prepared.messages.length = 0;
  }

  shutdown(): void {
    for (const controller of this.#active.values()) {
      controller.abort(new Error('server shutdown'));
    }
    this.#active.clear();
  }
}

function makeTitle(message: string): string {
  const normalized = message.replace(/\s+/g, ' ').trim();
  return normalized.length > 60
    ? `${normalized.slice(0, 57)}...`
    : normalized || 'Nueva conversación';
}

function summarizeProposal(proposal: unknown): unknown {
  if (!proposal || typeof proposal !== 'object') return proposal;
  const record = proposal as Record<string, unknown>;
  return {
    id: record.id,
    path: record.path,
    action: record.action,
    stats: record.stats,
    status: record.status,
  };
}
