import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, type SseEvent, streamChat } from '../api';
import { useI18n } from '../i18n';
import { classNames, formatBytes } from '../lib/format';
import type {
  ChatMessage,
  ChatMeta,
  ChatUsage,
  CommandInfo,
  ExecutionScope,
  MessageRecord,
  ModelRequirements,
  Project,
  Proposal,
  RuntimeModel,
  RuntimeStatus,
  Settings,
} from '../types';
import { CommandCard } from './CommandCard';
import {
  AlertIcon,
  CheckIcon,
  CopyIcon,
  FileIcon,
  FolderIcon,
  PaperclipIcon,
  RefreshIcon,
  SendIcon,
  SparklesIcon,
  StopIcon,
  XIcon,
} from './Icons';
import { Markdown } from './Markdown';
import { Modal } from './Modal';
import { ProposalCard } from './ProposalCard';

interface ChatViewProps {
  sessionKey: number;
  initialMessages: MessageRecord[];
  initialConversationId: string | null;
  settings: Settings | null;
  project: Project | null;
  models: RuntimeModel[];
  runtimeStatus: RuntimeStatus | null;
  runtimeLoading: boolean;
  executionScope: ExecutionScope;
  selectedModel: string;
  contextPaths: string[];
  onModelChange: (model: string) => void;
  onConversationId: (id: string) => void;
  onConversationFinished: () => void;
  onRefreshProposals: () => void;
  onRefreshBackups: () => void;
  onProposalApplied: (path: string) => void;
  appliedPaths: readonly string[];
  onOpenContext: () => void;
  onClearContext: () => void;
  onRemoveContextPath: (path: string) => void;
  onOpenSettings: () => void;
  notify: (message: string, kind?: 'info' | 'success' | 'error') => void;
}

let localId = 0;
function nextId(prefix: string): string {
  localId += 1;
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${localId}`;
}

function usageLabel(usage: ChatUsage | undefined): string | null {
  if (!usage) return null;
  const parts: string[] = [];
  if (usage.promptTokens) parts.push(`↑ ${usage.promptTokens}`);
  if (usage.completionTokens) parts.push(`↓ ${usage.completionTokens}`);
  if (usage.totalDurationMs) parts.push(`${(usage.totalDurationMs / 1000).toFixed(1)}s`);
  return parts.length ? parts.join(' · ') : null;
}

function requirementsLabel(requirements: ModelRequirements | undefined): string | null {
  if (!requirements?.estimatedRamBytes) return null;
  return `~${formatBytes(requirements.estimatedRamBytes)} RAM`;
}

function fromRecord(record: MessageRecord): ChatMessage {
  const metadata = record.metadata ?? {};
  const proposals = Array.isArray(metadata.proposals)
    ? (metadata.proposals as Proposal[]).filter(
        (proposal) => typeof proposal?.diff === 'string' && proposal.status === 'pending',
      )
    : [];
  const warnings = Array.isArray(metadata.warnings)
    ? (metadata.warnings as unknown[]).filter((item): item is string => typeof item === 'string')
    : [];
  const executionLocation = metadata.runtimeLocation;
  return {
    id: record.id,
    role: record.role,
    content: record.content,
    createdAt: record.createdAt,
    model: record.model,
    ...(executionLocation === 'local' ||
    executionLocation === 'private' ||
    executionLocation === 'remote'
      ? { executionLocation }
      : {}),
    proposals,
    warnings,
    usage:
      metadata.usage && typeof metadata.usage === 'object'
        ? (metadata.usage as ChatUsage)
        : undefined,
  };
}

export function ChatView(props: ChatViewProps) {
  const { t } = useI18n();
  const {
    sessionKey,
    initialMessages,
    initialConversationId,
    settings,
    project,
    models,
    runtimeStatus,
    runtimeLoading,
    executionScope,
    selectedModel,
    contextPaths,
    onModelChange,
    onConversationId,
    onConversationFinished,
    onRefreshProposals,
    onRefreshBackups,
    onProposalApplied,
    appliedPaths,
    onOpenContext,
    onClearContext,
    onRemoveContextPath,
    onOpenSettings,
    notify,
  } = props;

  const [messages, setMessages] = useState<ChatMessage[]>(() => initialMessages.map(fromRecord));
  const [conversationId, setConversationId] = useState<string | null>(initialConversationId);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [busyProposal, setBusyProposal] = useState<string | null>(null);
  const [remotePrompt, setRemotePrompt] = useState<{
    host: string;
    location: string;
    files: { path: string; bytes: number }[];
    totalBytes: number;
    body: Record<string, unknown>;
    assistantId: string;
  } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const stopRequested = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const lastBodyRef = useRef<Record<string, unknown> | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reiniciar solo al cambiar de sesión.
  useEffect(() => {
    setMessages(initialMessages.map(fromRecord));
    setConversationId(initialConversationId);
    setBanner(null);
    setInput('');
    setStreaming(false);
    abortRef.current?.abort();
    abortRef.current = null;
    stopRequested.current = false;
  }, [sessionKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: enfocar al cambiar de sesión.
  useEffect(() => {
    textareaRef.current?.focus();
  }, [sessionKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: desplazar al añadir mensajes.
  useEffect(() => {
    if (messages.length === 0) return;
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, streaming]);

  const updateAssistant = useCallback((id: string, patch: Partial<ChatMessage>) => {
    setMessages((current) =>
      current.map((message) => (message.id === id ? { ...message, ...patch } : message)),
    );
  }, []);

  const appendAssistantText = useCallback((id: string, text: string) => {
    setMessages((current) =>
      current.map((message) =>
        message.id === id ? { ...message, content: message.content + text } : message,
      ),
    );
  }, []);

  const handleEvent = useCallback(
    (assistantId: string, event: SseEvent) => {
      if (event.event === 'meta') {
        const meta = event.data as ChatMeta;
        updateAssistant(assistantId, { meta, model: meta.model, persisted: meta.persisted });
        if (meta.conversationId) {
          setConversationId(meta.conversationId);
          onConversationId(meta.conversationId);
        }
      } else if (event.event === 'delta') {
        const data = event.data as { text?: string };
        if (data.text) appendAssistantText(assistantId, data.text);
      } else if (event.event === 'proposals') {
        const data = event.data as { proposals?: Proposal[] };
        if (data.proposals) {
          updateAssistant(assistantId, { proposals: data.proposals });
          onRefreshProposals();
        }
      } else if (event.event === 'commands') {
        const data = event.data as { commands?: CommandInfo[] };
        if (data.commands) updateAssistant(assistantId, { commands: data.commands });
      } else if (event.event === 'warnings') {
        const data = event.data as { warnings?: string[] };
        if (data.warnings) {
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId
                ? { ...message, warnings: [...(message.warnings ?? []), ...data.warnings!] }
                : message,
            ),
          );
        }
      } else if (event.event === 'done') {
        const data = event.data as {
          usage?: ChatUsage;
          conversationId?: string | null;
          persisted?: boolean;
        };
        updateAssistant(assistantId, {
          streaming: false,
          usage: data.usage,
          persisted: data.persisted,
        });
        if (data.conversationId) {
          setConversationId(data.conversationId);
          onConversationId(data.conversationId);
        }
        setStreaming(false);
        onConversationFinished();
      } else if (event.event === 'error') {
        const data = event.data as {
          code?: string;
          message?: string;
          details?: Record<string, unknown>;
        };
        updateAssistant(assistantId, {
          streaming: false,
          error: {
            code: data.code ?? 'ERROR',
            message: data.message ?? t('sendError'),
            details: data.details,
          },
        });
        setStreaming(false);
      }
    },
    [
      appendAssistantText,
      onConversationFinished,
      onConversationId,
      onRefreshProposals,
      t,
      updateAssistant,
    ],
  );

  const performRequest = useCallback(
    async (body: Record<string, unknown>, assistantId: string) => {
      const controller = new AbortController();
      abortRef.current = controller;
      stopRequested.current = false;
      setStreaming(true);
      setBanner(null);
      updateAssistant(assistantId, {
        streaming: true,
        error: undefined,
        content: '',
        warnings: [],
      });
      try {
        await streamChat({
          body,
          signal: controller.signal,
          onEvent: (event) => handleEvent(assistantId, event),
        });
      } catch (caught) {
        const aborted = stopRequested.current || controller.signal.aborted;
        if (aborted) {
          updateAssistant(assistantId, { streaming: false });
          setBanner(t('stopped'));
        } else if (caught instanceof ApiError) {
          if (caught.code === 'CONTEXT_AUTHORIZATION_REQUIRED') {
            const details = caught.details ?? {};
            setRemotePrompt({
              host: String(details.runtimeHost ?? ''),
              location: String(details.runtimeLocation ?? ''),
              files: Array.isArray(details.files)
                ? (details.files as { path: string; bytes: number }[])
                : [],
              totalBytes: Number(details.totalBytes ?? 0),
              body,
              assistantId,
            });
            updateAssistant(assistantId, {
              streaming: false,
              error: { code: caught.code, message: caught.message },
            });
          } else {
            updateAssistant(assistantId, {
              streaming: false,
              error: { code: caught.code, message: caught.message, details: caught.details },
            });
            if (caught.code === 'RATE_LIMITED') setBanner(t('errorRateLimited'));
          }
          setStreaming(false);
        } else {
          updateAssistant(assistantId, {
            streaming: false,
            error: { code: 'NETWORK_ERROR', message: t('errorNetwork') },
          });
          setStreaming(false);
        }
      } finally {
        abortRef.current = null;
        setStreaming(false);
      }
    },
    [handleEvent, t, updateAssistant],
  );

  function send() {
    const text = input.trim();
    if (!text || streaming) return;
    if (!selectedModel) {
      setBanner(t('selectModelFirst'));
      return;
    }
    if (contextPaths.length > 0 && !project) {
      setBanner(t('contextRequired'));
      return;
    }
    const history = messages
      .filter((message) => !message.streaming && message.content.trim())
      .slice(-40)
      .map((message) => ({ role: message.role, content: message.content }));
    const persist = settings?.persistHistory ?? false;
    const body: Record<string, unknown> = {
      message: text,
      model: selectedModel,
      ...(project ? { projectId: project.id } : {}),
      ...(contextPaths.length > 0 ? { contextPaths } : {}),
      ...(persist && conversationId ? { conversationId } : {}),
      ...(!persist && history.length > 0 ? { history } : {}),
    };
    lastBodyRef.current = body;

    const userMessage: ChatMessage = {
      id: nextId('user'),
      role: 'user',
      content: text,
      createdAt: Date.now(),
    };
    const assistantMessage: ChatMessage = {
      id: nextId('assistant'),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      streaming: true,
      model: selectedModel,
    };
    setMessages((current) => [...current, userMessage, assistantMessage]);
    setInput('');
    onClearContext();
    void performRequest(body, assistantMessage.id);
  }

  function stop() {
    if (!abortRef.current) return;
    stopRequested.current = true;
    abortRef.current.abort();
  }

  function retry() {
    const body = lastBodyRef.current;
    if (!body || streaming) return;
    const assistantId = nextId('assistant');
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      streaming: true,
      model: selectedModel,
    };
    setMessages((current) => [...current, assistantMessage]);
    void performRequest(body, assistantId);
  }

  function resolveRemote(confirm: boolean) {
    const pending = remotePrompt;
    if (!pending) return;
    setRemotePrompt(null);
    if (!confirm) {
      setMessages((current) => current.filter((message) => message.id !== pending.assistantId));
      return;
    }
    const body = { ...pending.body, confirmRemoteContext: true };
    lastBodyRef.current = body;
    void performRequest(body, pending.assistantId);
  }

  async function applyProposal(proposal: Proposal, confirmation?: string) {
    setBusyProposal(proposal.id);
    try {
      const data = await api<{ proposal: Proposal }>(
        `/api/proposals/${encodeURIComponent(proposal.id)}/apply`,
        { method: 'POST', body: JSON.stringify(confirmation ? { confirmation } : {}) },
      );
      setMessages((current) =>
        current.map((message) => ({
          ...message,
          proposals: message.proposals?.map((item) =>
            item.id === proposal.id ? { ...item, ...data.proposal, status: 'applied' } : item,
          ),
        })),
      );
      notify(t('proposalAppliedMsg'), 'success');
      onProposalApplied(proposal.path);
      onRefreshProposals();
      onRefreshBackups();
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : t('applyFailed'), 'error');
    } finally {
      setBusyProposal(null);
    }
  }

  async function rejectProposal(proposal: Proposal) {
    setBusyProposal(proposal.id);
    try {
      await api<{ proposal: Proposal }>(
        `/api/proposals/${encodeURIComponent(proposal.id)}/reject`,
        { method: 'POST', body: JSON.stringify({}) },
      );
      setMessages((current) =>
        current.map((message) => ({
          ...message,
          proposals: message.proposals?.map((item) =>
            item.id === proposal.id ? { ...item, status: 'rejected' } : item,
          ),
        })),
      );
      notify(t('proposalRejectedMsg'), 'info');
      onRefreshProposals();
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : t('toastError'), 'error');
    } finally {
      setBusyProposal(null);
    }
  }

  async function copyMessage(content: string) {
    try {
      await navigator.clipboard.writeText(content);
      notify(t('toastCopied'), 'success');
    } catch {
      notify(t('toastError'), 'error');
    }
  }

  const activeModel = useMemo(
    () => models.find((model) => model.name === selectedModel) ?? null,
    [models, selectedModel],
  );
  const runtimeLabel = runtimeStatus?.runtime?.location ?? 'local';
  const runtimeClass =
    runtimeLabel === 'local' ? 'local' : runtimeLabel === 'private' ? 'private' : 'remote';

  return (
    <section className="chat-view">
      <header className="chat-toolbar">
        <div className="chat-toolbar-left">
          <span
            className={classNames('status-dot', runtimeStatus?.reachable ? 'online' : 'offline')}
          />
          <span className="small">
            {runtimeStatus?.reachable ? t('runtimeOnline') : t('runtimeOffline')}
            {runtimeStatus?.version ? ` · v${runtimeStatus.version}` : ''}
          </span>
          <span className={`badge runtime-${runtimeClass}`}>
            {runtimeLabel === 'local'
              ? t('runtimeLocal')
              : runtimeLabel === 'private'
                ? t('runtimePrivate')
                : t('runtimeRemote')}
          </span>
          <span
            className={`badge execution-${executionScope === 'this-computer' ? 'local' : 'remote'}`}
            title={
              executionScope === 'this-computer'
                ? t('executionThisComputerHint')
                : t('executionRemoteServerHint')
            }
          >
            {executionScope === 'this-computer'
              ? t('executionThisComputer')
              : t('executionRemoteServer')}
          </span>
        </div>
        <div className="chat-toolbar-right">
          <label className="model-picker">
            <span className="muted small">{t('modelLabel')}</span>
            <select
              value={selectedModel}
              onChange={(event) => onModelChange(event.target.value)}
              disabled={streaming}
            >
              <option value="">{t('modelPlaceholder')}</option>
              {models.map((model) => (
                <option key={model.name} value={model.name}>
                  {model.name}
                  {requirementsLabel(model.requirements)
                    ? ` · ${requirementsLabel(model.requirements)}`
                    : ''}
                </option>
              ))}
              {selectedModel && !models.some((model) => model.name === selectedModel) ? (
                <option value={selectedModel}>{selectedModel}</option>
              ) : null}
            </select>
          </label>
          {runtimeLoading ? <span className="muted small">{t('loading')}</span> : null}
          <button
            type="button"
            className="button ghost small"
            onClick={onOpenSettings}
            title={t('runtimeStatusTitle')}
          >
            <RefreshIcon size={15} />
          </button>
        </div>
      </header>

      <div className="chat-scroll">
        {messages.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon">
              <SparklesIcon size={30} />
            </span>
            <h2>{t('chatEmptyTitle')}</h2>
            <p className="muted">{t('chatEmptyText')}</p>
            {models.length === 0 ? (
              <div className="notice warn inline-notice">
                <AlertIcon size={16} />
                <span>{t('noModels')}</span>
              </div>
            ) : null}
            {!settings?.persistHistory ? (
              <div className="notice info inline-notice">
                <LockedMini />
                <span>{t('historyOffNotice')}</span>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="message-list">
            {messages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                projectId={project?.id ?? null}
                appliedPaths={appliedPaths}
                busyProposal={busyProposal}
                onCopy={() => void copyMessage(message.content)}
                onApply={applyProposal}
                onReject={rejectProposal}
                onRetry={message.role === 'assistant' ? retry : undefined}
              />
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <footer className="composer-wrap">
        {banner ? (
          <div className="notice warn composer-notice" role="status">
            <AlertIcon size={15} />
            <span>{banner}</span>
            <button type="button" className="icon-button tiny" onClick={() => setBanner(null)}>
              <XIcon size={14} />
            </button>
          </div>
        ) : null}

        <div className="composer">
          <div className="composer-meta">
            <button
              type="button"
              className={classNames('button ghost small', !project && 'muted')}
              onClick={onOpenContext}
            >
              <FolderIcon size={15} />
              {project ? project.name : t('noProjectSelected')}
            </button>
            {contextPaths.length > 0 ? (
              <div className="context-chips">
                {contextPaths.map((path) => (
                  <span className="chip" key={path} title={path}>
                    <FileIcon size={12} />
                    {path.split('/').pop()}
                    <button
                      type="button"
                      className="chip-remove"
                      onClick={() => onRemoveContextPath(path)}
                      aria-label={t('remove')}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <button type="button" className="link small-link" onClick={onClearContext}>
                  {t('clearSelection')}
                </button>
              </div>
            ) : (
              <span className="muted small">
                {activeModel?.requirements?.estimatedRamBytes
                  ? `${activeModel.details.parameterSize ?? ''} · ${formatBytes(
                      activeModel.sizeBytes,
                    )}`
                  : ''}
              </span>
            )}
          </div>

          <div className="composer-row">
            <button
              type="button"
              className="icon-button attach"
              onClick={onOpenContext}
              title={t('attachContext')}
              aria-label={t('attachContext')}
            >
              <PaperclipIcon />
            </button>
            <textarea
              ref={textareaRef}
              value={input}
              rows={1}
              maxLength={20000}
              placeholder={t('composerPlaceholder')}
              onChange={(event) => {
                setInput(event.target.value);
                const element = event.target;
                element.style.height = 'auto';
                element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  send();
                }
              }}
              disabled={streaming}
            />
            {streaming ? (
              <button type="button" className="button danger icon-text" onClick={stop}>
                <StopIcon size={16} />
                {t('stop')}
              </button>
            ) : (
              <button
                type="button"
                className="button primary icon-text"
                onClick={send}
                disabled={!input.trim() || !selectedModel}
              >
                <SendIcon size={16} />
                {t('send')}
              </button>
            )}
          </div>
          <div className="composer-foot muted small">
            <span>{settings?.persistHistory ? t('persistedNote') : t('ephemeralNote')}</span>
            <span>
              {contextPaths.length > 0
                ? t('attachedFiles', { count: contextPaths.length })
                : t('commandRunHint')}
            </span>
          </div>
        </div>
      </footer>

      {remotePrompt ? (
        <Modal
          title={t('remoteContextTitle')}
          onClose={() => resolveRemote(false)}
          footer={
            <div className="modal-actions">
              <button type="button" className="button ghost" onClick={() => resolveRemote(false)}>
                {t('cancel')}
              </button>
              <button type="button" className="button danger" onClick={() => resolveRemote(true)}>
                <CheckIcon size={15} />
                {t('remoteContextConfirm')}
              </button>
            </div>
          }
        >
          <div className="notice warn">
            <AlertIcon size={16} />
            <span>
              {t('remoteContextBody', {
                host: remotePrompt.host,
                location: remotePrompt.location,
              })}
            </span>
          </div>
          <ul className="remote-files">
            {remotePrompt.files.map((file) => (
              <li key={file.path}>
                <FileIcon size={13} />
                <code>{file.path}</code>
                <span className="muted small">{formatBytes(file.bytes)}</span>
              </li>
            ))}
          </ul>
          <p className="muted small">
            {formatBytes(remotePrompt.totalBytes)} ·{' '}
            {t('tokensEstimated', { count: Math.ceil(remotePrompt.totalBytes / 4) })}
          </p>
        </Modal>
      ) : null}
    </section>
  );
}

function MessageBubble({
  message,
  projectId,
  appliedPaths,
  busyProposal,
  onCopy,
  onApply,
  onReject,
  onRetry,
}: {
  message: ChatMessage;
  projectId: string | null;
  appliedPaths: readonly string[];
  busyProposal: string | null;
  onCopy: () => void;
  onApply: (proposal: Proposal, confirmation?: string) => void;
  onReject: (proposal: Proposal) => void;
  onRetry?: () => void;
}) {
  const { t } = useI18n();
  const isUser = message.role === 'user';
  const usage = usageLabel(message.usage);
  const pendingProposals = (message.proposals ?? []).filter(
    (proposal) => proposal.status === 'pending',
  );
  const warningItems = useMemo(() => {
    const counts = new Map<string, number>();
    return (message.warnings ?? []).map((warning) => {
      const count = counts.get(warning) ?? 0;
      counts.set(warning, count + 1);
      return { warning, key: `${warning}#${count}` };
    });
  }, [message.warnings]);
  const commandItems = useMemo(() => {
    const counts = new Map<string, number>();
    return (message.commands ?? []).map((command) => {
      const count = counts.get(command.command) ?? 0;
      counts.set(command.command, count + 1);
      return { command, key: `${command.command}#${count}` };
    });
  }, [message.commands]);
  const canRetry = !isUser && Boolean(message.error) && !message.streaming;

  return (
    <article className={classNames('message', isUser ? 'user' : 'assistant')}>
      <div className="message-avatar" aria-hidden="true">
        {isUser ? <span>{t('youName').slice(0, 1)}</span> : <SparklesIcon size={16} />}
      </div>
      <div className="message-body">
        <header className="message-head">
          <strong>{isUser ? t('youName') : t('assistantName')}</strong>
          {message.model && !isUser ? (
            <span className="muted small">{t('responseModel', { model: message.model })}</span>
          ) : null}
          {!isUser && message.executionLocation ? (
            <span
              className={`badge execution-${message.executionLocation === 'local' ? 'local' : 'remote'}`}
            >
              {message.executionLocation === 'local'
                ? t('executionThisComputer')
                : t('executionRemoteServer')}
            </span>
          ) : null}
          {message.persisted !== undefined ? (
            <span className="badge muted">
              {message.persisted ? t('persistedNote') : t('ephemeralNote')}
            </span>
          ) : null}
          {!isUser ? (
            <button type="button" className="icon-button tiny message-copy" onClick={onCopy}>
              <CopyIcon size={14} />
              <span className="sr-only">{t('copyMessage')}</span>
            </button>
          ) : null}
        </header>

        {isUser ? (
          <p className="user-text">{message.content}</p>
        ) : message.content ? (
          <Markdown content={message.content} />
        ) : message.streaming ? (
          <div className="typing">
            <span />
            <span />
            <span />
          </div>
        ) : null}

        {message.streaming && message.content ? <span className="cursor-blink" /> : null}

        {message.error ? (
          <div className="notice error" role="alert">
            <AlertIcon size={16} />
            <div>
              <p>{message.error.message}</p>
              {message.error.code === 'RUNTIME_OFFLINE' ? (
                <p className="muted small">{t('errorRuntimeOffline')}</p>
              ) : null}
              {canRetry ? <p className="muted small">{t('retryHint')}</p> : null}
              {canRetry && onRetry ? (
                <button type="button" className="button ghost small" onClick={onRetry}>
                  <RefreshIcon size={14} />
                  {t('retry')}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {message.warnings && message.warnings.length > 0 ? (
          <div className="notice warn">
            <AlertIcon size={15} />
            <ul className="plain-list">
              {warningItems.map(({ warning, key }) => (
                <li key={key}>{warning}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {pendingProposals.length > 0 ? (
          <div className="proposal-stack">
            {pendingProposals.map((proposal) => (
              <ProposalCard
                key={proposal.id}
                proposal={proposal}
                busy={busyProposal === proposal.id}
                onApply={onApply}
                onReject={onReject}
              />
            ))}
          </div>
        ) : null}

        {message.commands && message.commands.length > 0 ? (
          <div className="command-stack">
            {commandItems.map(({ command, key }) => (
              <CommandCard
                command={command}
                projectId={projectId}
                appliedPaths={appliedPaths}
                key={key}
              />
            ))}
          </div>
        ) : null}

        {message.meta ? (
          <footer className="message-foot muted small">
            {message.meta.context ? (
              <span>
                {t('tokensEstimated', {
                  count: message.meta.context.estimatedTokens,
                })}
              </span>
            ) : null}
            {message.meta.runtime ? (
              <span>
                {message.meta.runtime.host} ·{' '}
                {message.meta.runtime.location === 'local'
                  ? t('runtimeLocal')
                  : message.meta.runtime.location === 'private'
                    ? t('runtimePrivate')
                    : t('runtimeRemote')}
              </span>
            ) : null}
            {usage ? <span>{usage}</span> : null}
          </footer>
        ) : null}
      </div>
    </article>
  );
}

function LockedMini() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}
