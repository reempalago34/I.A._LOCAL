import { useState } from 'react';
import { RefreshIcon, ShieldIcon } from '../components/Icons';
import { ProposalCard } from '../components/ProposalCard';
import { useI18n } from '../i18n';
import type { Project, Proposal } from '../types';

interface ChangesViewProps {
  proposals: Proposal[];
  projects: Project[];
  loading: boolean;
  onRefresh: () => void;
  onApply: (proposal: Proposal) => Promise<void>;
  onReject: (proposal: Proposal) => Promise<void>;
  onOpenChat: () => void;
}

export function ChangesView({
  proposals,
  projects,
  loading,
  onRefresh,
  onApply,
  onReject,
  onOpenChat,
}: ChangesViewProps) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<string | null>(null);

  const pending = proposals.filter((proposal) => proposal.status === 'pending');
  const processed = proposals.filter((proposal) => proposal.status !== 'pending');

  async function apply(proposal: Proposal) {
    setBusy(proposal.id);
    try {
      await onApply(proposal);
    } finally {
      setBusy(null);
    }
  }

  async function reject(proposal: Proposal) {
    setBusy(proposal.id);
    try {
      await onReject(proposal);
    } finally {
      setBusy(null);
    }
  }

  function projectName(projectId: string): string | undefined {
    return projects.find((project) => project.id === projectId)?.name;
  }

  return (
    <section className="page-view">
      <header className="page-head">
        <div>
          <h1>{t('changesTitle')}</h1>
          <p className="muted">{t('changesSubtitle')}</p>
        </div>
        <div className="row gap-sm">
          <button type="button" className="button ghost" onClick={onRefresh} disabled={loading}>
            <RefreshIcon size={15} />
            {loading ? t('loading') : t('refresh')}
          </button>
        </div>
      </header>

      <div className="notice info">
        <ShieldIcon size={16} />
        <span>{t('changesHint')}</span>
      </div>

      <section className="changes-section">
        <header className="section-head">
          <h2>
            {t('pendingChanges')}
            <span className="count-pill">{pending.length}</span>
          </h2>
        </header>
        {pending.length === 0 ? (
          <div className="empty-state compact">
            <p className="muted">{t('noPendingChanges')}</p>
            <button type="button" className="button ghost small" onClick={onOpenChat}>
              {t('navChat')}
            </button>
          </div>
        ) : (
          <div className="proposal-stack">
            {pending.map((proposal) => (
              <ProposalCard
                key={proposal.id}
                proposal={proposal}
                projectName={projectName(proposal.projectId)}
                busy={busy === proposal.id}
                onApply={(item) => void apply(item)}
                onReject={(item) => void reject(item)}
              />
            ))}
          </div>
        )}
      </section>

      {processed.length > 0 ? (
        <section className="changes-section">
          <header className="section-head">
            <h2>
              {t('processedChanges')}
              <span className="count-pill">{processed.length}</span>
            </h2>
          </header>
          <div className="proposal-stack">
            {processed.map((proposal) => (
              <ProposalCard
                key={proposal.id}
                proposal={proposal}
                projectName={projectName(proposal.projectId)}
                busy={false}
                onApply={() => undefined}
                onReject={() => undefined}
              />
            ))}
          </div>
        </section>
      ) : null}
    </section>
  );
}
