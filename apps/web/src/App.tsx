import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api, setCsrfToken } from './api';
import { AuthView } from './components/AuthView';
import { ChatView } from './components/ChatView';
import { ContextModal } from './components/ContextModal';
import {
  AlertIcon,
  CheckIcon,
  ChevronRightIcon,
  DatabaseIcon,
  LogOutIcon,
  MenuIcon,
  MessageIcon,
  PlusIcon,
  SettingsIcon,
  ShieldIcon,
  SparklesIcon,
  TrashIcon,
  WrenchIcon,
  XIcon,
} from './components/Icons';
import { Modal } from './components/Modal';
import { SettingsView } from './components/SettingsView';
import { I18nProvider, type Language, useI18n } from './i18n';
import { classNames, relativeTime } from './lib/format';
import type {
  Backup,
  Conversation,
  ExecutionScope,
  MessageRecord,
  Project,
  Proposal,
  PublicUser,
  RuntimeModel,
  RuntimeStatus,
  Settings,
  SettingsResponse,
  StorageResponse,
  StorageUsage,
} from './types';
import { BackupsView } from './views/BackupsView';
import { ChangesView } from './views/ChangesView';
import { PrivacyView } from './views/PrivacyView';

type View = 'chat' | 'changes' | 'backups' | 'settings' | 'privacy';
type Theme = 'system' | 'light' | 'dark';
type ToastKind = 'info' | 'success' | 'error';

interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}

let toastSequence = 0;

function storedLanguage(): Language {
  try {
    return window.localStorage.getItem('forge.language') === 'en' ? 'en' : 'es';
  } catch {
    return 'es';
  }
}

function storedTheme(): Theme {
  try {
    const value = window.localStorage.getItem('forge.theme');
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function App() {
  const [language, setLanguage] = useState<Language>(storedLanguage);

  useEffect(() => {
    document.documentElement.lang = language;
    try {
      window.localStorage.setItem('forge.language', language);
    } catch {
      // El almacenamiento puede estar deshabilitado.
    }
  }, [language]);

  return (
    <I18nProvider language={language}>
      <ForgeApp language={language} onLanguageChange={setLanguage} />
    </I18nProvider>
  );
}

function ForgeApp({
  language,
  onLanguageChange,
}: {
  language: Language;
  onLanguageChange: (language: Language) => void;
}) {
  const { t } = useI18n();
  const [user, setUser] = useState<PublicUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<View>('chat');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [settingsData, setSettingsData] = useState<SettingsResponse | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [storageUsage, setStorageUsage] = useState<StorageUsage | null>(null);
  const [storageLoading, setStorageLoading] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [models, setModels] = useState<RuntimeModel[]>([]);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [selectedModel, setSelectedModel] = useState('');
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [contextPaths, setContextPaths] = useState<string[]>([]);
  const [contextOpen, setContextOpen] = useState(false);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationBusy, setConversationBusy] = useState<string | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null);
  const [sessionKey, setSessionKey] = useState(0);
  const [initialMessages, setInitialMessages] = useState<MessageRecord[]>([]);
  const [initialConversationId, setInitialConversationId] = useState<string | null>(null);

  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [proposalsLoading, setProposalsLoading] = useState(false);
  const [appliedPaths, setAppliedPaths] = useState<string[]>([]);
  const [backups, setBackups] = useState<Backup[]>([]);
  const [backupsLoading, setBackupsLoading] = useState(false);

  const [toasts, setToasts] = useState<Toast[]>([]);

  const notify = useCallback((message: string, kind: ToastKind = 'info') => {
    toastSequence += 1;
    const id = toastSequence;
    setToasts((current) => [...current, { id, message, kind }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 4200);
  }, []);

  const markProposalApplied = useCallback((proposalPath: string) => {
    setAppliedPaths((current) =>
      current.includes(proposalPath) ? current : [...current, proposalPath],
    );
  }, []);

  const loadSettings = useCallback(async () => {
    const data = await api<SettingsResponse>('/api/settings');
    setSettingsData(data);
    return data;
  }, []);

  const loadStorage = useCallback(async () => {
    setStorageLoading(true);
    try {
      const data = await api<StorageResponse>('/api/storage');
      setStorageUsage(data.usage);
    } catch {
      // El panel de almacenamiento es informativo; no bloquea el resto de la UI.
    } finally {
      setStorageLoading(false);
    }
  }, []);

  const loadProjects = useCallback(async () => {
    const data = await api<{ projects: Project[] }>('/api/projects');
    setProjects(data.projects);
  }, []);

  const loadConversations = useCallback(async () => {
    const data = await api<{ conversations: Conversation[] }>('/api/conversations');
    setConversations(data.conversations);
  }, []);

  const loadProposals = useCallback(async () => {
    setProposalsLoading(true);
    try {
      const data = await api<{ proposals: Proposal[] }>('/api/proposals');
      setProposals(data.proposals);
    } catch (caught) {
      if (caught instanceof ApiError) notify(caught.message, 'error');
    } finally {
      setProposalsLoading(false);
    }
  }, [notify]);

  const loadBackups = useCallback(async () => {
    setBackupsLoading(true);
    try {
      const data = await api<{ backups: Backup[] }>('/api/backups');
      setBackups(data.backups);
    } catch (caught) {
      if (caught instanceof ApiError) notify(caught.message, 'error');
    } finally {
      setBackupsLoading(false);
    }
  }, [notify]);

  const loadRuntime = useCallback(
    async (runtimeUrl?: string) => {
      setRuntimeLoading(true);
      try {
        const suffix = runtimeUrl ? `?runtimeUrl=${encodeURIComponent(runtimeUrl)}` : '';
        const status = await api<RuntimeStatus>(`/api/runtime/status${suffix}`);
        setRuntimeStatus(status);
        if (!status.reachable) {
          setModels([]);
          return;
        }
        try {
          const data = await api<{ models: RuntimeModel[] }>(`/api/runtime/models${suffix}`);
          setModels(data.models);
        } catch (caught) {
          setModels([]);
          setRuntimeStatus({
            reachable: false,
            error: {
              code: caught instanceof ApiError ? caught.code : 'RUNTIME_ERROR',
              message: caught instanceof ApiError ? caught.message : t('runtimeError'),
            },
          });
        }
      } catch (caught) {
        setModels([]);
        setRuntimeStatus({
          reachable: false,
          error: {
            code: caught instanceof ApiError ? caught.code : 'RUNTIME_OFFLINE',
            message: caught instanceof ApiError ? caught.message : t('runtimeError'),
          },
        });
      } finally {
        setRuntimeLoading(false);
      }
    },
    [t],
  );

  const bootstrapData = useCallback(async () => {
    const settings = await loadSettings().catch(() => null);
    await Promise.allSettled([
      loadProjects(),
      loadConversations(),
      loadProposals(),
      loadBackups(),
      loadStorage(),
    ]);
    void loadRuntime(settings?.settings.runtimeUrl);
  }, [
    loadSettings,
    loadProjects,
    loadConversations,
    loadProposals,
    loadBackups,
    loadStorage,
    loadRuntime,
  ]);

  const resetSession = useCallback(() => {
    setUser(null);
    setSettingsData(null);
    setStorageUsage(null);
    setProjects([]);
    setModels([]);
    setRuntimeStatus(null);
    setConversations([]);
    setProposals([]);
    setAppliedPaths([]);
    setBackups([]);
    setSelectedProject(null);
    setContextPaths([]);
    setSelectedModel('');
    setActiveConversationId(null);
    setInitialMessages([]);
    setInitialConversationId(null);
    setSessionKey((key) => key + 1);
    setView('chat');
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api<{ user: PublicUser; csrfToken: string }>('/api/auth/me');
        if (cancelled) return;
        setCsrfToken(data.csrfToken);
        setUser(data.user);
        await bootstrapData();
      } catch {
        // Sin sesión activa: se muestra la pantalla de acceso.
      } finally {
        if (!cancelled) setAuthChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bootstrapData]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ path?: string }>).detail;
      const path = detail?.path ?? '';
      if (
        path === '/api/auth/me' ||
        path === '/api/auth/csrf' ||
        path === '/api/auth/login' ||
        path === '/api/auth/register' ||
        path === '/api/auth/logout'
      ) {
        return;
      }
      setNotice(t('sessionExpired'));
      resetSession();
    };
    window.addEventListener('forge:unauthorized', handler);
    return () => window.removeEventListener('forge:unauthorized', handler);
  }, [resetSession, t]);

  useEffect(() => {
    if (!settingsData) return;
    onLanguageChange(settingsData.settings.language);
  }, [settingsData, onLanguageChange]);

  useEffect(() => {
    const theme = settingsData?.settings.theme ?? storedTheme();
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const resolved = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
      document.documentElement.dataset.theme = resolved;
    };
    apply();
    try {
      window.localStorage.setItem('forge.theme', theme);
    } catch {
      // El almacenamiento puede estar deshabilitado.
    }
    if (theme !== 'system') return;
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [settingsData?.settings.theme]);

  useEffect(() => {
    if (!models.length) {
      if (!selectedModel && settingsData?.settings.defaultModel) {
        setSelectedModel(settingsData.settings.defaultModel);
      }
      return;
    }
    if (selectedModel && models.some((model) => model.name === selectedModel)) return;
    const preferred = settingsData?.settings.defaultModel;
    const next =
      preferred && models.some((model) => model.name === preferred)
        ? preferred
        : (models[0]?.name ?? '');
    if (next !== selectedModel) setSelectedModel(next);
  }, [models, selectedModel, settingsData?.settings.defaultModel]);

  useEffect(() => {
    if (projects.length === 0) {
      if (selectedProject) setSelectedProject(null);
      return;
    }
    if (selectedProject && projects.some((project) => project.id === selectedProject.id)) {
      return;
    }
    setSelectedProject(projects[0] ?? null);
  }, [projects, selectedProject]);

  useEffect(() => {
    if (!user) return;
    if (view === 'changes') void loadProposals();
    else if (view === 'backups') void loadBackups();
    else if (view === 'settings') void loadStorage();
  }, [view, user, loadProposals, loadBackups, loadStorage]);

  function handleAuthenticated(authenticated: PublicUser) {
    setNotice(null);
    setUser(authenticated);
    void bootstrapData();
  }

  function navigate(next: View) {
    setView(next);
    setSidebarOpen(false);
  }

  function startNewChat() {
    setInitialMessages([]);
    setInitialConversationId(null);
    setActiveConversationId(null);
    setContextPaths([]);
    setSessionKey((key) => key + 1);
    setView('chat');
    setSidebarOpen(false);
  }

  async function openConversation(conversation: Conversation) {
    setConversationBusy(conversation.id);
    setSidebarOpen(false);
    try {
      const data = await api<{ conversation: Conversation; messages: MessageRecord[] }>(
        `/api/conversations/${encodeURIComponent(conversation.id)}`,
      );
      setInitialMessages(data.messages);
      setInitialConversationId(data.conversation.id);
      setActiveConversationId(data.conversation.id);
      setContextPaths([]);
      if (data.conversation.model) {
        setSelectedModel(data.conversation.model);
      }
      if (data.conversation.projectId) {
        const project = projects.find((item) => item.id === data.conversation.projectId);
        if (project) setSelectedProject(project);
      }
      setSessionKey((key) => key + 1);
      setView('chat');
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : t('toastError'), 'error');
    } finally {
      setConversationBusy(null);
    }
  }

  async function removeConversation() {
    const target = deleteTarget;
    if (!target) return;
    setConversationBusy(target.id);
    try {
      await api<{ ok: boolean }>(`/api/conversations/${encodeURIComponent(target.id)}`, {
        method: 'DELETE',
      });
      setDeleteTarget(null);
      notify(t('conversationDeleted'), 'success');
      await loadConversations();
      if (activeConversationId === target.id) startNewChat();
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : t('toastError'), 'error');
    } finally {
      setConversationBusy(null);
    }
  }

  async function logout() {
    try {
      await api<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
    } catch {
      // La sesión local se limpia igualmente.
    }
    setCsrfToken('');
    resetSession();
    setNotice(null);
    notify(t('toastLoggedOut'), 'info');
  }

  async function saveSettings(payload: Settings) {
    setSettingsSaving(true);
    try {
      const data = await api<{ settings: Settings }>('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      setSettingsData((current) =>
        current
          ? {
              ...current,
              settings: data.settings,
              storage: {
                ...current.storage,
                conversationsPersisted: data.settings.persistHistory,
              },
            }
          : current,
      );
      notify(t('settingsSaved'), 'success');
      void loadRuntime(data.settings.runtimeUrl);
      void loadConversations();
      void loadStorage();
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : t('toastError'), 'error');
      throw caught;
    } finally {
      setSettingsSaving(false);
    }
  }

  async function resetSettings() {
    setSettingsSaving(true);
    try {
      const data = await api<{ settings: Settings }>('/api/settings', { method: 'DELETE' });
      setSettingsData((current) =>
        current
          ? {
              ...current,
              settings: data.settings,
              storage: {
                ...current.storage,
                conversationsPersisted: data.settings.persistHistory,
              },
            }
          : current,
      );
      notify(t('settingsReset'), 'success');
      void loadRuntime(data.settings.runtimeUrl);
      void loadStorage();
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : t('toastError'), 'error');
      throw caught;
    } finally {
      setSettingsSaving(false);
    }
  }

  async function applyProposal(proposal: Proposal) {
    try {
      await api(`/api/proposals/${encodeURIComponent(proposal.id)}/apply`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      markProposalApplied(proposal.path);
      notify(t('proposalAppliedMsg'), 'success');
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : t('applyFailed'), 'error');
    } finally {
      void loadProposals();
      void loadBackups();
      void loadStorage();
    }
  }

  async function rejectProposal(proposal: Proposal) {
    try {
      await api(`/api/proposals/${encodeURIComponent(proposal.id)}/reject`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      notify(t('proposalRejectedMsg'), 'info');
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : t('toastError'), 'error');
    } finally {
      void loadProposals();
    }
  }

  function applyContext(project: Project | null, paths: string[]) {
    if (project) {
      setProjects((current) =>
        current.some((item) => item.id === project.id) ? current : [...current, project],
      );
      setSelectedProject(project);
    }
    setContextPaths(paths);
    setContextOpen(false);
    notify(t('toastContextUpdated'), 'success');
  }

  function handleProjectCreated(project: Project) {
    setProjects((current) =>
      current.some((item) => item.id === project.id) ? current : [...current, project],
    );
    notify(t('toastProjectCreated'), 'success');
  }

  function handleDataDeleted(scope: 'history' | 'backups' | 'all') {
    if (scope === 'history' || scope === 'all') {
      setConversations([]);
      startNewChat();
    }
    void loadBackups();
    void loadStorage();
  }

  const settings = settingsData?.settings ?? null;
  const pendingProposals = useMemo(
    () => proposals.filter((proposal) => proposal.status === 'pending').length,
    [proposals],
  );

  const executionScope = useMemo<ExecutionScope>(() => {
    if (!settingsData) return 'remote-server';
    if (settingsData.server.deploymentMode === 'server') return 'remote-server';
    return runtimeStatus?.runtime?.location === 'local' ? 'this-computer' : 'remote-server';
  }, [settingsData, runtimeStatus]);

  if (!authChecked) {
    return (
      <div className="boot-screen">
        <span className="brand-mark large">
          <SparklesIcon size={26} />
        </span>
        <p className="muted">{t('loading')}</p>
      </div>
    );
  }

  if (!user) {
    return <AuthView onAuthenticated={handleAuthenticated} notice={notice} />;
  }

  const navItems: { id: View; label: string; icon: typeof MessageIcon; count?: number }[] = [
    { id: 'chat', label: t('navChat'), icon: MessageIcon },
    { id: 'changes', label: t('navChanges'), icon: WrenchIcon, count: pendingProposals },
    { id: 'backups', label: t('navBackups'), icon: DatabaseIcon, count: backups.length },
    { id: 'settings', label: t('navSettings'), icon: SettingsIcon },
    { id: 'privacy', label: t('navPrivacy'), icon: ShieldIcon },
  ];

  return (
    <div className="app-shell">
      <aside className={classNames('sidebar', sidebarOpen && 'open')}>
        <div className="sidebar-head">
          <div className="brand">
            <span className="brand-mark">
              <SparklesIcon size={20} />
            </span>
            <div className="brand-text">
              <strong>{t('appName')}</strong>
              <span className="muted small">{t('appTagline')}</span>
            </div>
          </div>
          <button
            type="button"
            className="icon-button sidebar-close"
            onClick={() => setSidebarOpen(false)}
            aria-label={t('close')}
          >
            <XIcon size={18} />
          </button>
        </div>

        <button type="button" className="button primary block new-chat" onClick={startNewChat}>
          <PlusIcon size={16} />
          {t('newChat')}
        </button>

        <nav className="sidebar-nav" aria-label={t('actions')}>
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                className={classNames('nav-item', view === item.id && 'active')}
                onClick={() => navigate(item.id)}
              >
                <Icon size={17} />
                <span>{item.label}</span>
                {item.count ? <span className="nav-count">{item.count}</span> : null}
                <ChevronRightIcon size={14} className="nav-chevron" />
              </button>
            );
          })}
        </nav>

        <section className="sidebar-history">
          <h2>
            {t('conversations')}
            {settings?.persistHistory ? null : (
              <span className="badge muted">{t('historyOffShort')}</span>
            )}
          </h2>
          {!settings?.persistHistory ? (
            <p className="muted small">{t('privacyNoHistory')}</p>
          ) : conversations.length === 0 ? (
            <p className="muted small">{t('noConversations')}</p>
          ) : (
            <div className="conversation-list">
              {conversations.map((conversation) => (
                <div
                  key={conversation.id}
                  className={classNames(
                    'conversation-row',
                    activeConversationId === conversation.id && 'active',
                  )}
                >
                  <button
                    type="button"
                    className="conversation-main"
                    onClick={() => void openConversation(conversation)}
                    disabled={conversationBusy === conversation.id}
                  >
                    <span className="conversation-title">{conversation.title}</span>
                    <span className="muted small">
                      {conversationBusy === conversation.id
                        ? t('loading')
                        : relativeTime(conversation.updatedAt, Date.now(), language)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="icon-button tiny conversation-delete"
                    onClick={() => setDeleteTarget(conversation)}
                    aria-label={t('deleteConversation')}
                  >
                    <TrashIcon size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <div className="sidebar-foot">
          <div className="local-note small">
            <ShieldIcon size={14} />
            <span>{t('privacyLocalNote')}</span>
          </div>
          <div className="user-card">
            <span className="avatar" aria-hidden="true">
              {(user.displayName || user.email).slice(0, 1).toUpperCase()}
            </span>
            <div className="user-info">
              <strong>{user.displayName || user.email}</strong>
              <small className="muted">{user.email}</small>
            </div>
            <button
              type="button"
              className="icon-button"
              onClick={() => void logout()}
              title={t('logout')}
              aria-label={t('logout')}
            >
              <LogOutIcon size={16} />
            </button>
          </div>
        </div>
      </aside>

      <button
        type="button"
        className={classNames('sidebar-scrim', sidebarOpen && 'show')}
        onClick={() => setSidebarOpen(false)}
        aria-label={t('close')}
        tabIndex={sidebarOpen ? 0 : -1}
      />

      <main className="app-main">
        <header className="mobile-bar">
          <button
            type="button"
            className="icon-button"
            onClick={() => setSidebarOpen(true)}
            aria-label={t('openMenu')}
          >
            <MenuIcon size={20} />
          </button>
          <span className="brand-inline">
            <span className="brand-mark small">
              <SparklesIcon size={15} />
            </span>
            {t('appName')}
          </span>
          <span className="status-dot online" title={t('runtimeOnline')} />
        </header>

        {view === 'chat' ? (
          <ChatView
            sessionKey={sessionKey}
            initialMessages={initialMessages}
            initialConversationId={initialConversationId}
            settings={settings}
            project={selectedProject}
            models={models}
            runtimeStatus={runtimeStatus}
            runtimeLoading={runtimeLoading}
            executionScope={executionScope}
            selectedModel={selectedModel}
            contextPaths={contextPaths}
            onModelChange={setSelectedModel}
            onConversationId={setActiveConversationId}
            onConversationFinished={() => void loadConversations()}
            onRefreshProposals={() => void loadProposals()}
            onRefreshBackups={() => void loadBackups()}
            onProposalApplied={markProposalApplied}
            appliedPaths={appliedPaths}
            onOpenContext={() => setContextOpen(true)}
            onClearContext={() => setContextPaths([])}
            onRemoveContextPath={(path) =>
              setContextPaths((current) => current.filter((item) => item !== path))
            }
            onOpenSettings={() => {
              navigate('settings');
              void loadRuntime(settings?.runtimeUrl);
            }}
            notify={notify}
          />
        ) : view === 'changes' ? (
          <ChangesView
            proposals={proposals}
            projects={projects}
            loading={proposalsLoading}
            onRefresh={() => void loadProposals()}
            onApply={applyProposal}
            onReject={rejectProposal}
            onOpenChat={() => navigate('chat')}
          />
        ) : view === 'backups' ? (
          <BackupsView
            backups={backups}
            projects={projects}
            loading={backupsLoading}
            onRefresh={() => void loadBackups()}
            notify={notify}
          />
        ) : view === 'settings' ? (
          <SettingsView
            settings={settings}
            server={settingsData?.server ?? null}
            storage={settingsData?.storage ?? null}
            storageUsage={storageUsage}
            storageLoading={storageLoading}
            executionScope={executionScope}
            models={models}
            runtimeStatus={runtimeStatus}
            runtimeLoading={runtimeLoading}
            saving={settingsSaving}
            onSave={saveSettings}
            onReset={resetSettings}
            onReloadModels={() => void loadRuntime(settings?.runtimeUrl)}
            onRefreshStorage={() => void loadStorage()}
            onDataDeleted={handleDataDeleted}
            notify={notify}
          />
        ) : (
          <PrivacyView notify={notify} onDataDeleted={handleDataDeleted} />
        )}
      </main>

      {contextOpen ? (
        <ContextModal
          project={selectedProject}
          projects={projects}
          selectedPaths={contextPaths}
          onApply={applyContext}
          onProjectCreated={handleProjectCreated}
          onClose={() => setContextOpen(false)}
        />
      ) : null}

      {deleteTarget ? (
        <Modal
          title={t('deleteConversation')}
          subtitle={t('deleteConversationConfirm')}
          onClose={() => setDeleteTarget(null)}
          footer={
            <div className="modal-actions">
              <button type="button" className="button ghost" onClick={() => setDeleteTarget(null)}>
                {t('cancel')}
              </button>
              <button
                type="button"
                className="button danger"
                onClick={() => void removeConversation()}
                disabled={conversationBusy !== null}
              >
                <TrashIcon size={15} />
                {t('delete')}
              </button>
            </div>
          }
        >
          <p>
            <strong>{deleteTarget.title}</strong>
          </p>
        </Modal>
      ) : null}

      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.kind}`}>
            {toast.kind === 'success' ? (
              <CheckIcon size={16} />
            ) : toast.kind === 'error' ? (
              <AlertIcon size={16} />
            ) : (
              <ShieldIcon size={16} />
            )}
            <span>{toast.message}</span>
            <button
              type="button"
              className="icon-button tiny"
              onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))}
              aria-label={t('dismiss')}
            >
              <XIcon size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
