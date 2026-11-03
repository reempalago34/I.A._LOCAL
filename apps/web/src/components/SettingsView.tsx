import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api';
import { useI18n } from '../i18n';
import { formatBytes, formatDate } from '../lib/format';
import type {
  ExecutionScope,
  RuntimeModel,
  RuntimeStatus,
  ServerInfo,
  Settings,
  StorageInfo,
  StorageUsage,
  SystemResources,
} from '../types';
import {
  AlertIcon,
  CheckIcon,
  DatabaseIcon,
  RefreshIcon,
  ShieldIcon,
  TrashIcon,
  WrenchIcon,
} from './Icons';
import { Modal } from './Modal';

interface SettingsViewProps {
  settings: Settings | null;
  server: ServerInfo | null;
  storage: StorageInfo | null;
  storageUsage: StorageUsage | null;
  storageLoading: boolean;
  executionScope: ExecutionScope;
  models: RuntimeModel[];
  runtimeStatus: RuntimeStatus | null;
  runtimeLoading: boolean;
  saving: boolean;
  onSave: (settings: Settings) => Promise<void>;
  onReset: () => Promise<void>;
  onReloadModels: () => void;
  onRefreshStorage: () => void;
  onDataDeleted: (scope: 'history' | 'backups' | 'all') => void;
  notify: (message: string, kind?: 'info' | 'success' | 'error') => void;
}

type DeleteScope = 'history' | 'backups' | 'all';

interface Draft {
  runtimeUrl: string;
  defaultModel: string;
  persistHistory: boolean;
  language: 'es' | 'en';
  theme: 'system' | 'light' | 'dark';
  maxFileBytes: number;
  maxContextBytes: number;
  maxContextFiles: number;
  maxStorageBytes: number;
  excludePatternsText: string;
}

function toDraft(settings: Settings): Draft {
  return {
    ...settings,
    excludePatternsText: settings.excludePatterns.join('\n'),
  };
}

export function SettingsView({
  settings,
  server,
  storage,
  storageUsage,
  storageLoading,
  executionScope,
  models,
  runtimeStatus,
  runtimeLoading,
  saving,
  onSave,
  onReset,
  onReloadModels,
  onRefreshStorage,
  onDataDeleted,
  notify,
}: SettingsViewProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<Draft | null>(settings ? toDraft(settings) : null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [resources, setResources] = useState<SystemResources | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [deleteScope, setDeleteScope] = useState<DeleteScope | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(settings ? toDraft(settings) : null);
  }, [settings]);

  const runPreflight = useCallback(async () => {
    if (!draft) return;
    setPreflightLoading(true);
    setPreflightError(null);
    try {
      const params = new URLSearchParams();
      if (draft.runtimeUrl.trim()) params.set('runtimeUrl', draft.runtimeUrl.trim());
      if (draft.defaultModel.trim()) params.set('model', draft.defaultModel.trim());
      const data = await api<SystemResources>(
        `/api/system/resources${params.toString() ? `?${params.toString()}` : ''}`,
      );
      setResources(data);
    } catch (caught) {
      setPreflightError(caught instanceof ApiError ? caught.message : t('preflightFailed'));
    } finally {
      setPreflightLoading(false);
    }
  }, [draft, t]);

  if (!draft) {
    return (
      <section className="page-view">
        <p className="muted">{t('loading')}</p>
      </section>
    );
  }

  function patch(update: Partial<Draft>) {
    setDraft((current) => (current ? { ...current, ...update } : current));
    setOk(false);
  }

  async function save() {
    if (!draft || !settings) return;
    setError(null);
    setOk(false);
    if (draft.maxContextBytes < draft.maxFileBytes) {
      setError(
        'El límite total debe ser mayor o igual que el límite por archivo. / Total limit must be greater than or equal to the per-file limit.',
      );
      return;
    }
    if (draft.maxStorageBytes < 1_048_576) {
      setError(t('storageLimitTooLow'));
      return;
    }
    const payload: Settings = {
      runtimeUrl: draft.runtimeUrl.trim(),
      defaultModel: draft.defaultModel.trim(),
      persistHistory: draft.persistHistory,
      language: draft.language,
      theme: draft.theme,
      maxFileBytes: Math.round(draft.maxFileBytes),
      maxContextBytes: Math.round(draft.maxContextBytes),
      maxContextFiles: Math.round(draft.maxContextFiles),
      maxStorageBytes: Math.round(draft.maxStorageBytes),
      excludePatterns: draft.excludePatternsText
        .split(/[\n,]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    };
    try {
      await onSave(payload);
      setOk(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('errorGeneric'));
    }
  }

  async function reset() {
    setError(null);
    setOk(false);
    try {
      await onReset();
      setOk(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('errorGeneric'));
    }
  }

  async function removeData() {
    if (!deleteScope) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await api<{ ok: boolean }>('/api/privacy/data', {
        method: 'DELETE',
        body: JSON.stringify({ scope: deleteScope, confirmation: 'BORRAR' }),
      });
      notify(t('privacyDeleted'), 'success');
      onDataDeleted(deleteScope);
      onRefreshStorage();
      setDeleteScope(null);
      setDeleteConfirmation('');
    } catch (caught) {
      setDeleteError(caught instanceof ApiError ? caught.message : t('toastError'));
    } finally {
      setDeleteBusy(false);
    }
  }

  const storagePercent = storageUsage
    ? Math.min(
        100,
        Math.round((storageUsage.trackedBytes / Math.max(storageUsage.limitBytes, 1)) * 100),
      )
    : 0;

  return (
    <section className="page-view settings-view">
      <header className="page-head">
        <div>
          <h1>{t('settingsTitle')}</h1>
          <p className="muted">{t('settingsSubtitle')}</p>
        </div>
        <div className="row gap-sm">
          <button
            type="button"
            className="button ghost"
            onClick={() => void reset()}
            disabled={saving}
          >
            <RefreshIcon size={15} />
            {t('resetSettings')}
          </button>
          <button
            type="button"
            className="button primary"
            onClick={() => void save()}
            disabled={saving}
          >
            {saving ? t('saving') : t('saveSettings')}
          </button>
        </div>
      </header>

      {error ? (
        <div className="notice error" role="alert">
          <AlertIcon size={16} />
          <span>{error}</span>
        </div>
      ) : null}
      {ok ? (
        <div className="notice success" role="status">
          <ShieldIcon size={16} />
          <span>{t('settingsSaved')}</span>
        </div>
      ) : null}

      <div className="settings-grid">
        <section className="panel">
          <header className="panel-head">
            <WrenchIcon size={18} />
            <h2>{t('runtimeSection')}</h2>
          </header>
          <label className="field">
            <span>{t('runtimeUrlLabel')}</span>
            <input
              type="url"
              value={draft.runtimeUrl}
              maxLength={2048}
              onChange={(event) => patch({ runtimeUrl: event.target.value })}
              placeholder="http://127.0.0.1:11434"
            />
            <small className="muted">{t('runtimeUrlHint')}</small>
          </label>

          <label className="field">
            <span>{t('defaultModelLabel')}</span>
            <input
              list="model-options"
              value={draft.defaultModel}
              maxLength={200}
              onChange={(event) => patch({ defaultModel: event.target.value })}
              placeholder="modelo:etiqueta"
            />
            <datalist id="model-options">
              {models.map((model) => (
                <option value={model.name} key={model.name} />
              ))}
            </datalist>
            <small className="muted">{t('defaultModelHint')}</small>
          </label>

          <div className="runtime-summary">
            <div className="row gap-sm wrap">
              <span
                className={`badge execution-${executionScope === 'this-computer' ? 'local' : 'remote'}`}
              >
                {executionScope === 'this-computer'
                  ? t('executionThisComputer')
                  : t('executionRemoteServer')}
              </span>
              <span
                className={`status-dot ${runtimeStatus?.reachable ? 'online' : 'offline'}`}
                aria-hidden="true"
              />
              <strong>{runtimeStatus?.reachable ? t('runtimeOnline') : t('runtimeOffline')}</strong>
              {runtimeStatus?.version ? (
                <span className="muted small">
                  {t('runtimeVersion')} {runtimeStatus.version}
                </span>
              ) : null}
            </div>
            <p className="muted small">
              {executionScope === 'this-computer'
                ? t('executionThisComputerHint')
                : t('executionRemoteServerHint')}
            </p>
            {runtimeStatus?.runtime ? (
              <p className="muted small">
                {runtimeStatus.runtime.host} ·{' '}
                {runtimeStatus.runtime.location === 'local'
                  ? t('runtimeLocal')
                  : runtimeStatus.runtime.location === 'private'
                    ? t('runtimePrivate')
                    : t('runtimeRemote')}
              </p>
            ) : null}
            {runtimeStatus?.error ? (
              <div className="notice error small">
                <AlertIcon size={15} />
                <span>{runtimeStatus.error.message}</span>
              </div>
            ) : null}
            {executionScope === 'this-computer' ? (
              <div className="notice warn small">
                <AlertIcon size={15} />
                <span>{t('localExperimentalWarning')}</span>
              </div>
            ) : null}
          </div>

          <div className="row gap-sm wrap">
            <button
              type="button"
              className="button ghost small"
              onClick={onReloadModels}
              disabled={runtimeLoading}
            >
              <RefreshIcon size={14} />
              {runtimeLoading ? t('loading') : t('reloadModels')}
            </button>
            <button
              type="button"
              className="button ghost small"
              onClick={() => void runPreflight()}
              disabled={preflightLoading}
            >
              <ShieldIcon size={14} />
              {preflightLoading ? t('preflightRunning') : t('preflightButton')}
            </button>
            <span className="muted small">
              {models.length} {t('runtimeModels').toLowerCase()}
            </span>
          </div>
          {models.length === 0 ? <p className="muted small">{t('pullModelHint')}</p> : null}

          {preflightError ? (
            <div className="notice error small">
              <AlertIcon size={15} />
              <span>{preflightError}</span>
            </div>
          ) : null}
          {resources ? (
            <div className="preflight">
              <h3>{t('preflightTitle')}</h3>
              <dl className="info-grid">
                <div>
                  <dt>{t('hostResourcesRam')}</dt>
                  <dd>
                    {formatBytes(resources.host.freeMemoryBytes)} /{' '}
                    {formatBytes(resources.host.totalMemoryBytes)}
                  </dd>
                </div>
                <div>
                  <dt>{t('hostResourcesCpu')}</dt>
                  <dd>
                    {resources.host.cpuCount} · {resources.host.cpuModel}
                  </dd>
                </div>
                <div>
                  <dt>{t('hostResourcesDisk')}</dt>
                  <dd>{formatBytes(resources.storage.dataDir.freeBytes)}</dd>
                </div>
                <div>
                  <dt>{t('hostResourcesGpu')}</dt>
                  <dd>{resources.runtime.gpuActive ? t('gpuActive') : t('gpuNotConfirmed')}</dd>
                </div>
              </dl>
              {resources.runtime.loadedModels.length > 0 ? (
                <p className="muted small">
                  {t('loadedModelsLabel')}:{' '}
                  {resources.runtime.loadedModels
                    .map(
                      (model) =>
                        `${model.name} (${formatBytes(model.sizeBytes)}, VRAM ${formatBytes(
                          model.sizeVramBytes,
                        )})`,
                    )
                    .join(' · ')}
                </p>
              ) : null}
              <ul className="preflight-checks">
                {resources.checks.map((check) => (
                  <li key={check.id} className={`preflight-check ${check.level}`}>
                    {check.level === 'ok' ? <CheckIcon size={14} /> : <AlertIcon size={14} />}
                    <span>{check.message}</span>
                  </li>
                ))}
              </ul>
              {resources.warnings.map((warning) => (
                <p key={warning} className="muted small">
                  {warning}
                </p>
              ))}
            </div>
          ) : null}
        </section>

        <section className="panel">
          <header className="panel-head">
            <ShieldIcon size={18} />
            <h2>{t('privacySection')}</h2>
          </header>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.persistHistory}
              onChange={(event) => patch({ persistHistory: event.target.checked })}
            />
            <span>
              <strong>{t('persistHistoryLabel')}</strong>
              <small className="muted block">{t('persistHistoryHint')}</small>
            </span>
          </label>

          <div className="two-cols">
            <label className="field">
              <span>{t('languageLabel')}</span>
              <select
                value={draft.language}
                onChange={(event) => patch({ language: event.target.value === 'en' ? 'en' : 'es' })}
              >
                <option value="es">Español</option>
                <option value="en">English</option>
              </select>
            </label>
            <label className="field">
              <span>{t('themeLabel')}</span>
              <select
                value={draft.theme}
                onChange={(event) =>
                  patch({
                    theme:
                      event.target.value === 'light'
                        ? 'light'
                        : event.target.value === 'dark'
                          ? 'dark'
                          : 'system',
                  })
                }
              >
                <option value="system">{t('themeSystem')}</option>
                <option value="light">{t('themeLight')}</option>
                <option value="dark">{t('themeDark')}</option>
              </select>
            </label>
          </div>
          <p className="muted small">{t('settingsNote')}</p>
        </section>

        <section className="panel">
          <header className="panel-head">
            <DatabaseIcon size={18} />
            <h2>{t('limitsSection')}</h2>
          </header>
          <div className="three-cols">
            <label className="field">
              <span>{t('maxFileBytesLabel')}</span>
              <input
                type="number"
                min={1024}
                max={server?.limits.maxFileBytes ?? 2_097_152}
                value={draft.maxFileBytes}
                onChange={(event) => patch({ maxFileBytes: Number(event.target.value) })}
              />
            </label>
            <label className="field">
              <span>{t('maxContextBytesLabel')}</span>
              <input
                type="number"
                min={1024}
                max={server?.limits.maxContextBytes ?? 4_194_304}
                value={draft.maxContextBytes}
                onChange={(event) => patch({ maxContextBytes: Number(event.target.value) })}
              />
            </label>
            <label className="field">
              <span>{t('maxContextFilesLabel')}</span>
              <input
                type="number"
                min={1}
                max={server?.limits.maxContextFiles ?? 30}
                value={draft.maxContextFiles}
                onChange={(event) => patch({ maxContextFiles: Number(event.target.value) })}
              />
            </label>
          </div>
          {server ? (
            <p className="muted small">
              {t('hardLimits', {
                file: formatBytes(server.limits.maxFileBytes),
                total: formatBytes(server.limits.maxContextBytes),
                count: server.limits.maxContextFiles,
              })}
            </p>
          ) : null}

          <label className="field">
            <span>{t('excludesLabel')}</span>
            <textarea
              rows={4}
              value={draft.excludePatternsText}
              onChange={(event) => patch({ excludePatternsText: event.target.value })}
              placeholder={'*.generated.ts\nvendor/**'}
            />
            <small className="muted">{t('excludesHint')}</small>
          </label>
        </section>

        <section className="panel storage-panel">
          <header className="panel-head">
            <DatabaseIcon size={18} />
            <h2>{t('storageUsageTitle')}</h2>
            <span className="muted small">{t('storageUsageHint')}</span>
          </header>

          {storageUsage ? (
            <>
              <div className="storage-meter" aria-hidden="true">
                <div
                  className={`storage-meter-fill ${storageUsage.overLimit ? 'over' : ''}`}
                  style={{ width: `${storagePercent}%` }}
                />
              </div>
              <p className="muted small">
                {t('storageUsedOf', {
                  used: formatBytes(storageUsage.trackedBytes),
                  limit: formatBytes(storageUsage.limitBytes),
                })}{' '}
                · {storagePercent}%
              </p>
              <dl className="info-grid">
                <div>
                  <dt>{t('storageConversations')}</dt>
                  <dd>
                    {formatBytes(storageUsage.conversations.bytes)} ·{' '}
                    {storageUsage.conversations.messages} {t('privacyMessages').toLowerCase()}
                  </dd>
                </div>
                <div>
                  <dt>{t('storageBackups')}</dt>
                  <dd>
                    {formatBytes(storageUsage.backups.bytes)} · {storageUsage.backups.count}
                  </dd>
                </div>
                <div>
                  <dt>{t('storageTemp')}</dt>
                  <dd>{formatBytes(storageUsage.temporary.bytes)}</dd>
                </div>
                <div>
                  <dt>{t('storageCache')}</dt>
                  <dd>
                    {formatBytes(storageUsage.cache.bytes)} · {storageUsage.cache.entries}{' '}
                    {t('storageCacheEntries')}
                  </dd>
                </div>
                <div>
                  <dt>{t('storageDatabase')}</dt>
                  <dd>{formatBytes(storageUsage.database.bytes)}</dd>
                </div>
                <div>
                  <dt>{t('storageFreeDisk')}</dt>
                  <dd>{formatBytes(storageUsage.dataDir.freeBytes)}</dd>
                </div>
              </dl>
              {storageUsage.overLimit ? (
                <div className="notice warn small">
                  <AlertIcon size={15} />
                  <span>{t('storageOverLimit')}</span>
                </div>
              ) : null}
            </>
          ) : (
            <p className="muted small">{storageLoading ? t('loading') : t('storageUnavailable')}</p>
          )}

          <label className="field">
            <span>{t('storageLimitLabel')}</span>
            <input
              type="number"
              min={1_048_576}
              max={server?.limits.maxStorageBytes ?? 67_108_864}
              value={draft.maxStorageBytes}
              onChange={(event) => patch({ maxStorageBytes: Number(event.target.value) })}
            />
            <small className="muted">
              {t('storageLimitHint', {
                max: formatBytes(server?.limits.maxStorageBytes ?? 67_108_864),
              })}
            </small>
          </label>

          <div className="row gap-sm wrap">
            <button
              type="button"
              className="button ghost small"
              onClick={onRefreshStorage}
              disabled={storageLoading}
            >
              <RefreshIcon size={14} />
              {storageLoading ? t('loading') : t('refresh')}
            </button>
            <button
              type="button"
              className="button ghost small danger-text"
              onClick={() => {
                setDeleteScope('history');
                setDeleteConfirmation('');
                setDeleteError(null);
              }}
            >
              <TrashIcon size={14} />
              {t('privacyDeleteHistory')}
            </button>
            <button
              type="button"
              className="button ghost small danger-text"
              onClick={() => {
                setDeleteScope('backups');
                setDeleteConfirmation('');
                setDeleteError(null);
              }}
            >
              <TrashIcon size={14} />
              {t('privacyDeleteBackups')}
            </button>
          </div>
        </section>

        <section className="panel">
          <header className="panel-head">
            <WrenchIcon size={18} />
            <h2>{t('serverSection')}</h2>
          </header>
          {server ? (
            <dl className="info-grid">
              <div>
                <dt>{t('deploymentMode')}</dt>
                <dd>{server.deploymentMode}</dd>
              </div>
              <div>
                <dt>{t('registrationLabel')}</dt>
                <dd>{server.registrationEnabled ? t('enabled') : t('disabled')}</dd>
              </div>
              <div>
                <dt>{t('commandsLabel')}</dt>
                <dd>{server.commandExecutionEnabled ? t('enabled') : t('disabled')}</dd>
              </div>
              <div>
                <dt>{t('telemetryLabel')}</dt>
                <dd>{t('disabled')}</dd>
              </div>
            </dl>
          ) : null}
          {storage ? (
            <>
              <dl className="info-grid">
                <div>
                  <dt>{t('conversationsStored')}</dt>
                  <dd>{storage.conversationsPersisted ? t('yes') : t('no')}</dd>
                </div>
                <div>
                  <dt>{t('backupsRetention')}</dt>
                  <dd>{t('daysCount', { count: storage.backupsRetentionDays })}</dd>
                </div>
              </dl>
              <p className="muted small">{storage.note}</p>
            </>
          ) : null}
          <p className="muted small">{t('telemetryDisabled')}</p>
        </section>
      </div>

      <section className="panel models-panel">
        <header className="panel-head">
          <RefreshIcon size={18} />
          <h2>{t('runtimeStatusTitle')}</h2>
          <span className="muted small">{t('hardwareNote')}</span>
        </header>
        {models.length === 0 ? (
          <p className="muted">{t('noModelsFound')}</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('modelTableName')}</th>
                  <th>{t('modelTableParams')}</th>
                  <th>{t('modelTableQuant')}</th>
                  <th>{t('modelTableContext')}</th>
                  <th>{t('modelTableRam')}</th>
                  <th>{t('modelTableDisk')}</th>
                </tr>
              </thead>
              <tbody>
                {models.map((model) => (
                  <tr key={model.name}>
                    <td>
                      <code>{model.name}</code>
                      {model.modifiedAt ? (
                        <small className="muted block">
                          {formatDate(Date.parse(model.modifiedAt))}
                        </small>
                      ) : null}
                    </td>
                    <td>{model.details.parameterSize ?? '—'}</td>
                    <td>{model.details.quantizationLevel ?? '—'}</td>
                    <td>
                      {model.capabilities.contextLength
                        ? model.capabilities.contextLength.toLocaleString()
                        : '—'}
                    </td>
                    <td>
                      {model.requirements.estimatedRamBytes
                        ? formatBytes(model.requirements.estimatedRamBytes)
                        : t('unknown')}
                    </td>
                    <td>{formatBytes(model.requirements.diskBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {deleteScope ? (
        <Modal
          title={
            deleteScope === 'history'
              ? t('privacyDeleteHistory')
              : deleteScope === 'backups'
                ? t('privacyDeleteBackups')
                : t('privacyDeleteAll')
          }
          subtitle={t('privacyDeleteBody')}
          onClose={() => {
            if (!deleteBusy) setDeleteScope(null);
          }}
          footer={
            <div className="modal-actions">
              <button
                type="button"
                className="button ghost"
                onClick={() => setDeleteScope(null)}
                disabled={deleteBusy}
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                className="button danger"
                onClick={() => void removeData()}
                disabled={deleteBusy || deleteConfirmation !== 'BORRAR'}
              >
                <TrashIcon size={15} />
                {deleteBusy ? t('loading') : t('delete')}
              </button>
            </div>
          }
        >
          <div className="notice warn">
            <AlertIcon size={16} />
            <span>{t('privacyDeleteBody')}</span>
          </div>
          {deleteError ? (
            <div className="notice error small">
              <AlertIcon size={15} />
              <span>{deleteError}</span>
            </div>
          ) : null}
          <label className="field">
            <span>{t('privacyTypeConfirm')}</span>
            <input
              value={deleteConfirmation}
              onChange={(event) => setDeleteConfirmation(event.target.value)}
              autoComplete="off"
              placeholder="BORRAR"
            />
          </label>
        </Modal>
      ) : null}
    </section>
  );
}
