import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api';
import {
  AlertIcon,
  DatabaseIcon,
  HistoryIcon,
  MessageIcon,
  RefreshIcon,
  ShieldIcon,
  TrashIcon,
} from '../components/Icons';
import { Modal } from '../components/Modal';
import { useI18n } from '../i18n';
import type { PrivacyInfo } from '../types';

type Scope = 'history' | 'backups' | 'all';

interface PrivacyViewProps {
  notify: (message: string, kind?: 'info' | 'success' | 'error') => void;
  onDataDeleted: (scope: Scope) => void;
}

export function PrivacyView({ notify, onDataDeleted }: PrivacyViewProps) {
  const { t } = useI18n();
  const [info, setInfo] = useState<PrivacyInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [scope, setScope] = useState<Scope | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setInfo(await api<PrivacyInfo>('/api/privacy'));
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : t('toastError'), 'error');
    } finally {
      setLoading(false);
    }
  }, [notify, t]);

  useEffect(() => {
    void load();
  }, [load]);

  function openScope(next: Scope) {
    setScope(next);
    setConfirmation('');
    setError(null);
  }

  async function remove() {
    if (!scope) return;
    setBusy(true);
    setError(null);
    try {
      await api<{ ok: boolean }>('/api/privacy/data', {
        method: 'DELETE',
        body: JSON.stringify({ scope, confirmation: 'BORRAR' }),
      });
      notify(t('privacyDeleted'), 'success');
      onDataDeleted(scope);
      setScope(null);
      setConfirmation('');
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('toastError'));
    } finally {
      setBusy(false);
    }
  }

  const scopeLabel =
    scope === 'history'
      ? t('privacyDeleteHistory')
      : scope === 'backups'
        ? t('privacyDeleteBackups')
        : t('privacyDeleteAll');

  return (
    <section className="page-view">
      <header className="page-head">
        <div>
          <h1>{t('privacyTitle')}</h1>
          <p className="muted">{t('privacySubtitle')}</p>
        </div>
        <button
          type="button"
          className="button ghost"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshIcon size={15} />
          {loading ? t('loading') : t('refresh')}
        </button>
      </header>

      <div className="privacy-grid">
        <section className="panel">
          <header className="panel-head">
            <MessageIcon size={18} />
            <h2>{t('privacyConversations')}</h2>
          </header>
          <p className="privacy-number">{info ? info.conversations : '—'}</p>
          <p className="muted small">
            {t('privacyMessages')}: <strong>{info ? info.messages : '—'}</strong>
          </p>
        </section>

        <section className="panel">
          <header className="panel-head">
            <DatabaseIcon size={18} />
            <h2>{t('privacyBackups')}</h2>
          </header>
          <p className="privacy-number">{info ? info.backups : '—'}</p>
          <p className="muted small">
            {info ? t('privacyRetention', { days: info.backupRetentionDays }) : ''}
          </p>
        </section>

        <section className="panel">
          <header className="panel-head">
            <HistoryIcon size={18} />
            <h2>{t('privacyHistory')}</h2>
          </header>
          <p>
            <span className={`badge ${info?.historyEnabled ? 'success' : 'muted'}`}>
              {info?.historyEnabled ? t('enabled') : t('disabled')}
            </span>
          </p>
          <p className="muted small">
            {info?.historyEnabled ? t('privacyNote') : t('privacyNoHistory')}
          </p>
        </section>

        <section className="panel">
          <header className="panel-head">
            <ShieldIcon size={18} />
            <h2>{t('privacyTelemetry')}</h2>
          </header>
          <p>
            <span className="badge muted">{t('disabled')}</span>
          </p>
          <p className="muted small">{t('privacyLocalNote')}</p>
        </section>
      </div>

      <section className="panel">
        <header className="panel-head">
          <ShieldIcon size={18} />
          <h2>{t('privacyTitle')}</h2>
        </header>
        <div className="notice info">
          <ShieldIcon size={16} />
          <span>{info?.note ?? t('privacyNote')}</span>
        </div>

        <div className="danger-zone">
          <div>
            <h3>{t('privacyDeleteTitle')}</h3>
            <p className="muted small">{t('privacyDeleteBody')}</p>
          </div>
          <div className="row gap-sm wrap">
            <button
              type="button"
              className="button ghost danger-text"
              onClick={() => openScope('history')}
            >
              <TrashIcon size={14} />
              {t('privacyDeleteHistory')}
            </button>
            <button
              type="button"
              className="button ghost danger-text"
              onClick={() => openScope('backups')}
            >
              <TrashIcon size={14} />
              {t('privacyDeleteBackups')}
            </button>
            <button type="button" className="button danger" onClick={() => openScope('all')}>
              <TrashIcon size={14} />
              {t('privacyDeleteAll')}
            </button>
          </div>
        </div>
      </section>

      {scope ? (
        <Modal
          title={scopeLabel}
          subtitle={t('privacyDeleteBody')}
          onClose={() => {
            if (!busy) setScope(null);
          }}
          footer={
            <div className="modal-actions">
              <button
                type="button"
                className="button ghost"
                onClick={() => setScope(null)}
                disabled={busy}
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                className="button danger"
                onClick={() => void remove()}
                disabled={busy || confirmation !== 'BORRAR'}
              >
                <TrashIcon size={15} />
                {busy ? t('loading') : t('delete')}
              </button>
            </div>
          }
        >
          <div className="notice warn">
            <AlertIcon size={16} />
            <span>{t('privacyDeleteBody')}</span>
          </div>
          {error ? (
            <div className="notice error" role="alert">
              <AlertIcon size={16} />
              <span>{error}</span>
            </div>
          ) : null}
          <label className="field">
            <span>{t('privacyTypeConfirm')}</span>
            <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
          </label>
        </Modal>
      ) : null}
    </section>
  );
}
