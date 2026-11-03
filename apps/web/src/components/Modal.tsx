import { type PropsWithChildren, type ReactNode, useEffect, useRef } from 'react';
import { useI18n } from '../i18n';
import { XIcon } from './Icons';

interface ModalProps extends PropsWithChildren {
  title: string;
  subtitle?: string;
  onClose: () => void;
  wide?: boolean;
  footer?: ReactNode;
}

export function Modal({ title, subtitle, onClose, wide, footer, children }: ModalProps) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [onClose]);

  return (
    <div className="modal-layer">
      <button
        type="button"
        className="modal-backdrop"
        onClick={onClose}
        aria-label={t('close')}
        tabIndex={-1}
      />
      <div
        className={wide ? 'modal-panel modal-wide' : 'modal-panel'}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panelRef}
      >
        <header className="modal-header">
          <div>
            <h2>{title}</h2>
            {subtitle ? <p className="muted small">{subtitle}</p> : null}
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t('close')}>
            <XIcon />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </div>
    </div>
  );
}
