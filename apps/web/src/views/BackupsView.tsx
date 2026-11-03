import { useMemo, useState } from 'react';
import { ApiError, api } from '../api';
import {
  AlertIcon,
  DatabaseIcon,
  FileIcon,
  RefreshIcon,
  RotateIcon,
  TrashIcon,
} from '../components/Icons';
import { Modal } from '../components/Modal';
import { useI18n } from '../i18n';
import { formatDate } from '../lib/format';
import type { Backup, Project } from '../types';

interface BackupsViewProps {
  backups: Backup[];
  projects: Project[];
  loading: boolean;
  onRefresh: () => void;
  notify: (message: string, kind?: 'info' | 'success' | 'error') => void;
}

export function BackupsView({ backups, projects, loading, onRefresh, notify }: BackupsViewProps) {
  const { t, language } = useI18n();
  const [restoreTarget, setRestoreTarget] = useState<Backup | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Backup | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [force, setForce] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projectNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects) map.set(project.id, project.name);
    return map;
  }, [projects]);

  function openRestore(backup: Backup) {
    setRestoreTarget(backup);
    setConfirmation('');
    setForce(false);
    setConflict(false);
    setError(null);
  }

  function closeRestore() {
    if (busy) return;
    setRestoreTarget(null);
    setConfirmation('');
    setError(null);
    setConflict(false);
  }

  async function restore() {
    const target = restoreTarget;
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await api<{ ok: boolean }>(`/api/backups/${encodeURIComponent(target.id)}/restore`, {
        method: 'POST',
        body: JSON.stringify({ confirmation: 'RESTAURAR', force }),
      });
      setRestoreTarget(null);
      setConfirmation('');
      notify(t('backupRestoredMsg'), 'success');
      onRefresh();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'BACKUP_CONFLICT') {
        setConflict(true);
        setError(caught.message);
      } else {
        setError(caught instanceof ApiError ? caught.message : t('backupRestoreFailed'));
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const target = deleteTarget;
    if (!target) return;
    setBusy(true);
    try {
      await api<{ ok: boolean }>(`/api/backups/${encodeURIComponent(target.id)}`, {
        method: 'DELETE',
      });
      setDeleteTarget(null);
      notify(t('backupDeletedMsg'), 'success');
      onRefresh();
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : t('toastError'), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page-view">
      <header className="page-head">
        <div>
          <h1>{t('backupsTitle')}</h1>
          <p className="muted">{t('backupsSubtitle')}</p>
        </div>
        <button type="button" className="button ghost" onClick={onRefresh} disabled={loading}>
          <RefreshIcon size={15} />
          {loading ? t('loading') : t('refresh')}
        </button>
      </header>

      {backups.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon">
            <DatabaseIcon size={28} />
          </span>
          <p className="muted">{t('noBackups')}</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table backups-table">
            <thead>
              <tr>
                <th>{t('backupPath')}</th>
                <th>{t('proposalProject')}</th>
                <th>{t('backupCreated')}</th>
                <th>{t('backupExpires')}</th>
                <th>{t('actions')}</th>
              </tr>
            </thead>
            <tbody>
              {backups.map((backup) => {
                const restored = Boolean(backup.restoredAt);
                return (
                  <tr key={backup.id} className={restored ? 'row-muted' : undefined}>
                    <td>
                      <span className="inline-icon">
                        <FileIcon size={14} />
                        <code>{backup.path}</code>
                      </span>
                      {!backup.existed ? (
                        <small className="muted block">{t('backupOriginalMissing')}</small>
                      ) : null}
                    </td>
                    <td>{projectNames.get(backup.projectId) ?? '—'}</td>
                    <td className="small">{formatDate(backup.createdAt, language)}</td>
                    <td className="small">
                      {restored ? (
                        <span className="badge success">{t('backupRestored')}</span>
                      ) : (
                        formatDate(backup.expiresAt, language)
                      )}
                    </td>
                    <td>
                      <div className="row gap-xs">
                        <button
                          type="button"
                          className="button ghost small"
                          onClick={() => openRestore(backup)}
                          disabled={restored}
                        >
                          <RotateIcon size={14} />
                          {t('backupRestore')}
                        </button>
                        <button
                          type="button"
                          className="button ghost small danger-text"
                          onClick={() => setDeleteTarget(backup)}
                          aria-label={t('backupDelete')}
                        >
                          <TrashIcon size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {restoreTarget ? (
        <Modal
          title={t('backupRestoreTitle')}
          subtitle={t('backupRestoreBody', { path: restoreTarget.path })}
          onClose={closeRestore}
          footer={
            <div className="modal-actions">
              <button type="button" className="button ghost" onClick={closeRestore} disabled={busy}>
                {t('cancel')}
              </button>
              <button
                type="button"
                className="button primary"
                onClick={() => void restore()}
                disabled={busy || confirmation !== 'RESTAURAR'}
              >
                <RotateIcon size={15} />
                {busy ? t('loading') : t('backupRestore')}
              </button>
            </div>
          }
        >
          {error ? (
            <div className="notice error" role="alert">
              <AlertIcon size={16} />
              <span>{error}</span>
            </div>
          ) : null}
          {conflict ? (
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={force}
                onChange={(event) => setForce(event.target.checked)}
              />
              <span>
                <strong>{t('backupForce')}</strong>
                <small className="muted block">{t('backupConflict')}</small>
              </span>
            </label>
          ) : null}
          <label className="field">
            <span>{t('backupRestoreConfirm')}</span>
            <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
          </label>
        </Modal>
      ) : null}

      {deleteTarget ? (
        <Modal
          title={t('backupDeleteTitle')}
          subtitle={t('backupDeleteBody')}
          onClose={() => (busy ? undefined : setDeleteTarget(null))}
          footer={
            <div className="modal-actions">
              <button
                type="button"
                className="button ghost"
                onClick={() => setDeleteTarget(null)}
                disabled={busy}
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                className="button danger"
                onClick={() => void remove()}
                disabled={busy}
              >
                <TrashIcon size={15} />
                {busy ? t('loading') : t('delete')}
              </button>
            </div>
          }
        >
          <p>
            <code>{deleteTarget.path}</code>
          </p>
        </Modal>
      ) : null}
    </section>
  );
}
