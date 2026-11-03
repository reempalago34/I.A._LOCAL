import { type FormEvent, useEffect, useState } from 'react';
import { ApiError, api, ensureCsrf, setCsrfToken } from '../api';
import { useI18n } from '../i18n';
import type { AuthConfig, PublicUser } from '../types';
import { AlertIcon, LockIcon, SparklesIcon } from './Icons';

interface AuthViewProps {
  onAuthenticated: (user: PublicUser) => void;
  notice?: string | null;
}

export function AuthView({ onAuthenticated, notice }: AuthViewProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void ensureCsrf().catch(() => undefined);
    api<AuthConfig>('/api/auth/config')
      .then((value) => {
        if (!cancelled) setConfig(value);
      })
      .catch(() => {
        if (!cancelled) setConfig(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (mode === 'register' && password !== confirmPassword) {
      setError(t('passwordMismatch'));
      return;
    }
    setBusy(true);
    try {
      await ensureCsrf();
      const payload =
        mode === 'login'
          ? { email, password }
          : { email, password, displayName: displayName.trim() || undefined };
      const data = await api<{ user: PublicUser; csrfToken: string }>(
        mode === 'login' ? '/api/auth/login' : '/api/auth/register',
        { method: 'POST', body: JSON.stringify(payload) },
      );
      setCsrfToken(data.csrfToken);
      onAuthenticated(data.user);
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught.message);
      } else {
        setError(t('errorGeneric'));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="brand auth-brand">
          <span className="brand-mark">
            <SparklesIcon size={22} />
          </span>
          <div>
            <h1>{t('appName')}</h1>
            <p className="muted small">{t('appTagline')}</p>
          </div>
        </div>

        <h2 className="auth-title">{mode === 'login' ? t('authTitle') : t('signUp')}</h2>
        <p className="muted">{t('authSubtitle')}</p>

        {notice ? (
          <div className="notice warn" role="status">
            <AlertIcon size={16} />
            <span>{notice}</span>
          </div>
        ) : null}

        <form onSubmit={(event) => void submit(event)} className="stack">
          <label className="field">
            <span>{t('email')}</span>
            <input
              type="email"
              autoComplete="username"
              required
              maxLength={254}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>

          {mode === 'register' ? (
            <label className="field">
              <span>
                {t('displayName')} <span className="muted">({t('optional')})</span>
              </span>
              <input
                type="text"
                autoComplete="nickname"
                maxLength={80}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </label>
          ) : null}

          <label className="field">
            <span>{t('password')}</span>
            <input
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
              minLength={mode === 'register' ? 12 : 1}
              maxLength={200}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>

          {mode === 'register' ? (
            <>
              <label className="field">
                <span>{t('confirmPassword')}</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  maxLength={200}
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                />
              </label>
              <p className="muted small">{t('passwordHint')}</p>
            </>
          ) : null}

          {error ? (
            <div className="notice error" role="alert">
              <AlertIcon size={16} />
              <span>{error}</span>
            </div>
          ) : null}

          <button type="submit" className="button primary large" disabled={busy}>
            <LockIcon size={16} />
            {busy ? t('loading') : mode === 'login' ? t('signIn') : t('signUp')}
          </button>
        </form>

        {mode === 'login' ? (
          <div className="auth-switch">
            <span className="muted">{t('noAccount')}</span>{' '}
            {config?.registrationEnabled === false ? (
              <span className="muted small">{t('registrationDisabled')}</span>
            ) : (
              <button type="button" className="link" onClick={() => setMode('register')}>
                {t('signUp')}
              </button>
            )}
          </div>
        ) : (
          <div className="auth-switch">
            <span className="muted">{t('haveAccount')}</span>{' '}
            <button type="button" className="link" onClick={() => setMode('login')}>
              {t('signIn')}
            </button>
          </div>
        )}

        <footer className="auth-footer muted small">
          <p>{t('privacyLocalNote')}</p>
          <p>{t('firstRunHint')}</p>
        </footer>
      </section>
    </main>
  );
}
