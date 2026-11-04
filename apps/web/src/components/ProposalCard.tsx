import { useMemo, useState } from 'react';
import { useI18n } from '../i18n';
import { formatDate } from '../lib/format';
import type { Proposal } from '../types';
import { AlertIcon, CheckIcon, FileIcon, TrashIcon, XIcon } from './Icons';
import { Modal } from './Modal';

interface ProposalCardProps {
  proposal: Proposal;
  projectName?: string;
  busy?: boolean;
  onApply: (proposal: Proposal, confirmation?: string) => void;
  onReject: (proposal: Proposal) => void;
}

export function DiffLines({ diff }: { diff: string }) {
  const lines = useMemo(() => {
    const counts = new Map<string, number>();
    return diff
      .replace(/\n$/, '')
      .split('\n')
      .map((line) => {
        const count = counts.get(line) ?? 0;
        counts.set(line, count + 1);
        return { line, key: `${line}#${count}` };
      });
  }, [diff]);
  return (
    <pre className="diff-view">
      {lines.map(({ line, key }) => {
        let kind = 'ctx';
        if (line.startsWith('@@')) kind = 'hunk';
        else if (line.startsWith('+++') || line.startsWith('---')) kind = 'meta';
        else if (line.startsWith('+')) kind = 'add';
        else if (line.startsWith('-')) kind = 'del';
        return (
          <span className={`diff-line ${kind}`} key={key}>
            {line || ' '}
          </span>
        );
      })}
    </pre>
  );
}

export function ProposalCard({
  proposal,
  projectName,
  busy,
  onApply,
  onReject,
}: ProposalCardProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const pending = proposal.status === 'pending';

  function requestApply(): void {
    if (proposal.sensitive) {
      setConfirmation('');
      setConfirmOpen(true);
      return;
    }
    onApply(proposal);
  }

  function confirmApply(): void {
    if (confirmation !== 'APLICAR') return;
    setConfirmOpen(false);
    setConfirmation('');
    onApply(proposal, 'APLICAR');
  }

  return (
    <article className={`proposal-card ${proposal.status}`}>
      <header className="proposal-head">
        <div className="proposal-title">
          <span className={`badge ${proposal.action === 'delete' ? 'danger' : 'success'}`}>
            {proposal.action === 'delete' ? t('proposalDelete') : t('proposalWrite')}
          </span>
          <FileIcon size={15} />
          <code>{proposal.path}</code>
          {proposal.sensitive ? (
            <span className="badge warn" title={proposal.sensitiveReason}>
              {t('proposalSensitiveBadge')}
            </span>
          ) : null}
          {projectName ? <span className="muted small">{projectName}</span> : null}
        </div>
        <div className="proposal-meta">
          <span className="diff-stat add">+{proposal.stats.additions}</span>
          <span className="diff-stat del">−{proposal.stats.deletions}</span>
          <button type="button" className="link small-link" onClick={() => setExpanded(!expanded)}>
            {expanded ? t('close') : t('details')}
          </button>
        </div>
      </header>

      {proposal.sensitive ? (
        <div className="notice warn small" role="alert">
          <AlertIcon size={15} />
          <span>{proposal.sensitiveReason ?? t('proposalSensitiveHint')}</span>
        </div>
      ) : null}

      {expanded ? <DiffLines diff={proposal.diff} /> : null}

      <footer className="proposal-foot">
        <span className="muted small">
          {t('proposalExpires')}: {formatDate(proposal.expiresAt)}
        </span>
        <div className="row gap-sm">
          {pending ? (
            <>
              <button
                type="button"
                className="button ghost small"
                onClick={() => onReject(proposal)}
                disabled={busy}
              >
                <XIcon size={14} />
                {t('proposalReject')}
              </button>
              <button
                type="button"
                className="button primary small"
                onClick={requestApply}
                disabled={busy}
              >
                <CheckIcon size={14} />
                {t('proposalApply')}
              </button>
            </>
          ) : (
            <span className={`badge ${proposal.status === 'applied' ? 'success' : 'muted'}`}>
              {proposal.status === 'applied' ? t('proposalApplied') : t('proposalRejected')}
            </span>
          )}
          {proposal.action === 'delete' ? <TrashIcon size={14} className="muted" /> : null}
        </div>
      </footer>

      {confirmOpen ? (
        <Modal
          title={t('proposalSensitiveTitle')}
          subtitle={t('proposalSensitiveConfirmBody', { path: proposal.path })}
          onClose={() => {
            if (!busy) setConfirmOpen(false);
          }}
          footer={
            <div className="modal-actions">
              <button
                type="button"
                className="button ghost"
                onClick={() => setConfirmOpen(false)}
                disabled={busy}
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                className="button primary"
                onClick={confirmApply}
                disabled={busy || confirmation !== 'APLICAR'}
              >
                <CheckIcon size={14} />
                {t('proposalApply')}
              </button>
            </div>
          }
        >
          <div className="notice warn small" role="alert">
            <AlertIcon size={15} />
            <span>{proposal.sensitiveReason ?? t('proposalSensitiveHint')}</span>
          </div>
          <label className="field">
            <span>{t('proposalSensitiveConfirmType')}</span>
            <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
          </label>
        </Modal>
      ) : null}
    </article>
  );
}
