import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '../api';
import { useI18n } from '../i18n';
import { dirname, formatBytes } from '../lib/format';
import type { ContextPreview, DirectoryListing, FileEntry, Project } from '../types';
import {
  AlertIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  LockIcon,
  PlusIcon,
  RefreshIcon,
} from './Icons';
import { Modal } from './Modal';

interface ContextModalProps {
  project: Project | null;
  projects: Project[];
  selectedPaths: string[];
  onApply: (project: Project | null, paths: string[]) => void;
  onProjectCreated: (project: Project) => void;
  onClose: () => void;
}

export function ContextModal({
  project,
  projects,
  selectedPaths,
  onApply,
  onProjectCreated,
  onClose,
}: ContextModalProps) {
  const { t } = useI18n();
  const [activeProject, setActiveProject] = useState<Project | null>(project);
  const [dirPath, setDirPath] = useState('');
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>(selectedPaths);
  const [preview, setPreview] = useState<ContextPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [creating, setCreating] = useState(false);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const load = useCallback(
    async (target: Project | null, path: string) => {
      setLoading(true);
      setError(null);
      try {
        const url = target
          ? `/api/projects/${encodeURIComponent(target.id)}/tree?path=${encodeURIComponent(path)}`
          : `/api/workspace?path=${encodeURIComponent(path)}`;
        const data = await api<DirectoryListing>(url);
        setListing(data);
        setDirPath(data.path);
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : t('errorGeneric'));
        setListing(null);
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    void load(activeProject, '');
  }, [activeProject, load]);

  function navigate(path: string) {
    setPreview(null);
    setDirPath(path);
    void load(activeProject, path);
  }

  function toggle(path: string) {
    setPreview(null);
    setSelected((current) =>
      current.includes(path) ? current.filter((item) => item !== path) : [...current, path],
    );
  }

  function switchProject(next: Project | null) {
    setActiveProject(next);
    setDirPath('');
    setPreview(null);
    setSelected([]);
  }

  async function createProject() {
    setCreating(true);
    setError(null);
    try {
      const data = await api<{ project: Project }>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ path: dirPath }),
      });
      onProjectCreated(data.project);
      setActiveProject(data.project);
      setDirPath('');
      setSelected([]);
      setPreview(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('errorGeneric'));
    } finally {
      setCreating(false);
    }
  }

  async function showPreview() {
    if (!activeProject || selected.length === 0) return;
    setPreviewing(true);
    setError(null);
    try {
      const data = await api<ContextPreview>('/api/context/preview', {
        method: 'POST',
        body: JSON.stringify({ projectId: activeProject.id, paths: selected }),
      });
      setPreview(data);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('errorGeneric'));
    } finally {
      setPreviewing(false);
    }
  }

  const breadcrumbs = dirPath ? dirPath.split('/') : [];
  const isWorkspace = activeProject === null;

  return (
    <Modal
      title={t('contextTitle')}
      subtitle={t('contextSubtitle')}
      onClose={onClose}
      wide
      footer={
        <div className="modal-actions split">
          <div className="muted small">
            {t('selectedCount', { count: selected.length })}
            {selected.length > 0 ? (
              <button
                type="button"
                className="link small-link"
                onClick={() => {
                  setSelected([]);
                  setPreview(null);
                }}
              >
                {t('clearSelection')}
              </button>
            ) : null}
          </div>
          <div className="row gap-sm">
            <button type="button" className="button ghost" onClick={onClose}>
              {t('cancel')}
            </button>
            <button
              type="button"
              className="button ghost"
              onClick={() => void showPreview()}
              disabled={selected.length === 0 || previewing}
            >
              {previewing ? t('loading') : t('previewContext')}
            </button>
            <button
              type="button"
              className="button primary"
              onClick={() => onApply(activeProject, selected)}
              disabled={selected.length === 0}
            >
              <CheckSelectionIcon />
              {t('applyContext')}
            </button>
          </div>
        </div>
      }
    >
      <div className="context-toolbar">
        <label className="field inline">
          <span>{t('projectLabel')}</span>
          <select
            value={activeProject?.id ?? ''}
            onChange={(event) => {
              const next = projects.find((item) => item.id === event.target.value) ?? null;
              switchProject(next);
            }}
          >
            <option value="">{t('browseWorkspace')}</option>
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="button ghost small"
          onClick={() => void load(activeProject, dirPath)}
          disabled={loading}
        >
          <RefreshIcon size={15} />
          {t('refresh')}
        </button>
      </div>

      <div className="context-columns">
        <section className="context-browser">
          <div className="breadcrumbs">
            <button
              type="button"
              className="icon-button"
              onClick={() => navigate(dirname(dirPath))}
              disabled={!dirPath}
              aria-label={t('parentFolder')}
            >
              <ChevronLeftIcon size={16} />
            </button>
            <button
              type="button"
              className="crumb"
              onClick={() => navigate('')}
              disabled={!dirPath}
            >
              {isWorkspace ? t('workspaceTitle') : t('projectTreeTitle')}
            </button>
            {breadcrumbs.map((segment, index) => {
              const target = breadcrumbs.slice(0, index + 1).join('/');
              return (
                <span className="crumb-group" key={target}>
                  <span className="crumb-sep">/</span>
                  <button
                    type="button"
                    className="crumb"
                    onClick={() => navigate(target)}
                    disabled={target === dirPath}
                  >
                    {segment}
                  </button>
                </span>
              );
            })}
          </div>

          {isWorkspace ? (
            <div className="notice info small">
              <FolderIcon size={15} />
              <span>{t('workspaceHint')}</span>
            </div>
          ) : (
            <p className="muted small">
              {t('projectRootHint', { path: activeProject?.rootPath ?? '' })}
            </p>
          )}

          {error ? (
            <div className="notice error" role="alert">
              <AlertIcon size={16} />
              <span>{error}</span>
            </div>
          ) : null}

          <div className="file-list" aria-busy={loading}>
            {loading ? (
              <p className="muted small">{t('loadingFolder')}</p>
            ) : listing && listing.entries.length > 0 ? (
              listing.entries.map((entry) => (
                <EntryRow
                  key={entry.path}
                  entry={entry}
                  selected={selectedSet.has(entry.path)}
                  onNavigate={() => navigate(entry.path)}
                  onToggle={() => toggle(entry.path)}
                />
              ))
            ) : (
              <p className="muted small">{t('emptyFolder')}</p>
            )}
          </div>

          {listing?.truncated ? <p className="muted small">{t('truncatedNotice')}</p> : null}

          {isWorkspace ? (
            <div className="context-add">
              <p className="muted small">
                {t('currentFolder')}: <code>{dirPath || '/'}</code>
              </p>
              <button
                type="button"
                className="button primary small"
                onClick={() => void createProject()}
                disabled={creating}
              >
                <PlusIcon size={15} />
                {creating ? t('addingProject') : t('addProject')}
              </button>
            </div>
          ) : null}
        </section>

        <aside className="context-side">
          {preview ? (
            <>
              <div className="row space-between">
                <h3>{t('previewTitle')}</h3>
                <button type="button" className="link small-link" onClick={() => setPreview(null)}>
                  {t('close')}
                </button>
              </div>
              <div className="notice warn small">
                <LockIcon size={15} />
                <span>{preview.disclaimer ?? t('previewDisclaimer')}</span>
              </div>
              <p className="muted small">
                {preview.files.length} · {formatBytes(preview.totalBytes)} ·{' '}
                {t('tokensEstimated', { count: preview.estimatedTokens })}
              </p>
              {preview.errors.length > 0 ? (
                <div className="preview-errors">
                  <h4>{t('previewErrors')}</h4>
                  <ul>
                    {preview.errors.map((item) => (
                      <li key={item.path}>
                        <code>{item.path}</code>: {item.message}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {preview.files.length === 0 ? (
                <p className="muted small">{t('previewEmpty')}</p>
              ) : (
                <div className="preview-files">
                  {preview.files.map((file) => (
                    <details key={file.path} className="preview-file">
                      <summary>
                        <FileIcon size={14} />
                        <span>{file.path}</span>
                        <span className="muted small">
                          {formatBytes(file.bytes)} · {file.lines} {t('linesLabel').toLowerCase()}
                        </span>
                      </summary>
                      <pre>{file.content}</pre>
                    </details>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <h3>{t('selectedCount', { count: selected.length })}</h3>
              {selected.length === 0 ? (
                <p className="muted small">{t('noFilesSelected')}</p>
              ) : (
                <ul className="selected-list">
                  {selected.map((path) => (
                    <li key={path}>
                      <FileIcon size={14} />
                      <span title={path}>{path}</span>
                      <button
                        type="button"
                        className="icon-button tiny"
                        onClick={() => toggle(path)}
                        aria-label={t('remove')}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="notice info small">
                <LockIcon size={15} />
                <span>{t('selectFilesHint')}</span>
              </div>
            </>
          )}
        </aside>
      </div>
    </Modal>
  );
}

function EntryRow({
  entry,
  selected,
  onNavigate,
  onToggle,
}: {
  entry: FileEntry;
  selected: boolean;
  onNavigate: () => void;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  if (entry.type === 'blocked') {
    return (
      <div className="file-row blocked" title={entry.reason}>
        <LockIcon size={16} />
        <span className="file-name">{entry.name}</span>
        <span className="badge danger">{entry.reason ?? t('symlinkBlocked')}</span>
      </div>
    );
  }
  if (entry.type === 'directory') {
    return (
      <button type="button" className="file-row" onClick={onNavigate}>
        <FolderIcon size={16} />
        <span className="file-name">{entry.name}</span>
        <ChevronRightIcon size={15} />
      </button>
    );
  }
  return (
    <label className={selected ? 'file-row selectable selected' : 'file-row selectable'}>
      <input type="checkbox" checked={selected} onChange={onToggle} />
      <FileIcon size={16} />
      <span className="file-name">{entry.name}</span>
      {entry.size !== undefined ? (
        <span className="muted small">{formatBytes(entry.size)}</span>
      ) : null}
    </label>
  );
}

function CheckSelectionIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="m20 6-11 11-5-5" />
    </svg>
  );
}
