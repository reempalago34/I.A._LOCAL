import { useState } from 'react';
import { ApiError, api } from '../api';
import { useI18n } from '../i18n';
import type { CommandInfo, CommandResult } from '../types';
import { AlertIcon, PlayIcon, TerminalIcon, WrenchIcon } from './Icons';
import { Modal } from './Modal';

interface CommandCardProps {
  command: CommandInfo;
  projectId: string | null;
}

export function CommandCard({ command, projectId }: CommandCardProps) {
  const { t } = useI18n();
  const [analysis, setAnalysis] = useState<CommandInfo | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CommandResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const effective = analysis ?? command;
  const canRun = Boolean(projectId) && effective.allowed && effective.enabled;

  async function analyze() {
    if (!projectId) return;
    setAnalyzing(true);
    setError(null);
    try {
      const data = await api<CommandInfo>('/api/commands/analyze', {
        method: 'POST',
        body: JSON.stringify({ projectId, command: command.command }),
      });
      setAnalysis(data);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('commandRunFailed'));
    } finally {
      setAnalyzing(false);
    }
  }

  async function run() {
    if (!projectId) return;
    setRunning(true);
    setError(null);
    try {
      const data = await api<CommandResult>('/api/commands/execute', {
        method: 'POST',
        body: JSON.stringify({ projectId, command: command.command, confirmation: 'EJECUTAR' }),
      });
      setResult(data);
      setConfirmOpen(false);
      setConfirmation('');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('commandRunFailed'));
    } finally {
      setRunning(false);
    }
  }

  return (
    <article className="command-card">
      <header className="command-head">
        <TerminalIcon size={16} />
        <code>{command.command}</code>
        <span className={`badge ${effective.allowed ? 'success' : 'danger'}`}>
          {effective.allowed ? t('commandAllowed') : t('commandBlocked')}
        </span>
        {!effective.enabled ? <span className="badge muted">{t('commandDisabled')}</span> : null}
      </header>

      <p className="muted small">{t('commandRunHint')}</p>
      {effective.reason ? (
        <p className="small">
          <strong>{t('commandReason')}:</strong> {effective.reason}
        </p>
      ) : null}
      <details className="small">
        <summary>{t('commandEffects')}</summary>
        <p className="muted">{effective.effects}</p>
      </details>

      {error ? (
        <div className="notice error small" role="alert">
          <AlertIcon size={15} />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="row gap-sm wrap">
        <button
          type="button"
          className="button ghost small"
          onClick={() => void analyze()}
          disabled={analyzing || !projectId}
        >
          <WrenchIcon size={14} />
          {analyzing ? t('loading') : t('commandAnalyze')}
        </button>
        <button
          type="button"
          className="button danger small"
          onClick={() => {
            setConfirmation('');
            setConfirmOpen(true);
          }}
          disabled={!canRun || running}
          title={!canRun ? (effective.reason ?? t('commandDisabled')) : undefined}
        >
          <PlayIcon size={14} />
          {t('commandRun')}
        </button>
        {!effective.enabled ? <span className="muted small">{t('commandNotRun')}</span> : null}
      </div>

      {result ? <CommandOutput result={result} /> : null}

      {confirmOpen ? (
        <Modal
          title={t('commandConfirmTitle')}
          subtitle={t('commandConfirmBody', {
            cwd: effective.cwd ?? analysis?.cwd ?? '',
          })}
          onClose={() => {
            if (!running) setConfirmOpen(false);
          }}
          footer={
            <div className="modal-actions">
              <button
                type="button"
                className="button ghost"
                onClick={() => setConfirmOpen(false)}
                disabled={running}
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                className="button danger"
                onClick={() => void run()}
                disabled={running || confirmation !== 'EJECUTAR'}
              >
                <PlayIcon size={14} />
                {running ? t('loading') : t('commandRun')}
              </button>
            </div>
          }
        >
          <label className="field">
            <span>{t('commandConfirmType')}</span>
            <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
          </label>
        </Modal>
      ) : null}
    </article>
  );
}

function CommandOutput({ result }: { result: CommandResult }) {
  const { t } = useI18n();
  return (
    <div className="command-output">
      <div className="row gap-sm wrap small muted">
        <span>
          {t('commandExitCode')}: <strong>{result.exitCode ?? '—'}</strong>
        </span>
        <span>
          {t('commandDuration')}: <strong>{result.durationMs} ms</strong>
        </span>
        {result.timedOut ? <span className="badge danger">{t('commandTimedOut')}</span> : null}
        {result.truncated ? <span className="badge warn">{t('commandTruncated')}</span> : null}
      </div>
      {result.stdout ? (
        <>
          <h4>{t('commandStdout')}</h4>
          <pre>{result.stdout}</pre>
        </>
      ) : null}
      {result.stderr ? (
        <>
          <h4>{t('commandStderr')}</h4>
          <pre className="stderr">{result.stderr}</pre>
        </>
      ) : null}
      {!result.stdout && !result.stderr ? <p className="muted small">—</p> : null}
    </div>
  );
}
