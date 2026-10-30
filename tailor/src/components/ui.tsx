import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { dismissToast, useStore } from '../lib/store';

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
    />
  );
}

/** One dot per recent work session; filled where it happened. */
export function SessionDots({ sessions, total }: { sessions: number; total: number }) {
  const n = Math.min(Math.max(total, sessions), 10);
  return (
    <span className="dots" role="img" aria-label={`${sessions} of ${total} work sessions`}>
      {Array.from({ length: n }, (_, i) => (
        <i key={i} className={i < sessions ? 'on' : undefined} style={{ ['--d' as string]: i }} />
      ))}
    </span>
  );
}

export function DemoTag({ show = true }: { show?: boolean }) {
  if (!show) return null;
  return (
    <span className="tag tag--demo" title="From the sample week, not your real activity">
      Sample
    </span>
  );
}

export function Notice({
  tone = 'info',
  icon,
  children,
  actions,
}: {
  tone?: 'info' | 'error';
  icon?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={`notice${tone === 'error' ? ' notice--error' : ''}`} role={tone === 'error' ? 'alert' : undefined}>
      {icon}
      <p>{children}</p>
      {actions && <div className="notice-actions">{actions}</div>}
    </div>
  );
}

export function Dialog({ title, children, actions, onClose }: { title: string; children: ReactNode; actions: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="dialog-scrim" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="dialog-title">{title}</h2>
        {children}
        <div className="row row--end">{actions}</div>
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast${t.tone === 'error' ? ' toast--error' : ''}`}>
          <p>{t.text}</p>
          {t.action && (
            <button
              className="btn btn--sm"
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="btn btn--sm btn--icon" aria-label="Close" onClick={() => dismissToast(t.id)}>
            <X />
          </button>
        </div>
      ))}
    </div>
  );
}
