import { useMemo, useState } from 'react';
import { useI18n } from '../i18n';
import { formatDate } from '../lib/format';
import type { Proposal } from '../types';
import { CheckIcon, FileIcon, TrashIcon, XIcon } from './Icons';

interface ProposalCardProps {
  proposal: Proposal;
  projectName?: string;
  busy?: boolean;
  onApply: (proposal: Proposal) => void;
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
  const pending = proposal.status === 'pending';

  return (
    <article className={`proposal-card ${proposal.status}`}>
      <header className="proposal-head">
        <div className="proposal-title">
          <span className={`badge ${proposal.action === 'delete' ? 'danger' : 'success'}`}>
            {proposal.action === 'delete' ? t('proposalDelete') : t('proposalWrite')}
          </span>
          <FileIcon size={15} />
          <code>{proposal.path}</code>
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
                onClick={() => onApply(proposal)}
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
    </article>
  );
}
