import { useEffect } from 'react';

import CloseButton from '@shared/components/CloseButton';
import { useHmiStore, type ToastEntry } from '@hmi/store/hmiStore';

import './ConfigToastStack.css';

function ConfigToast({ toast }: { toast: ToastEntry }) {
  const dismissToast = useHmiStore((s) => s.dismissToast);

  useEffect(() => {
    if (toast.discard !== 'auto') return;
    const timer = setTimeout(() => dismissToast(toast.id), toast.duration);
    return () => clearTimeout(timer);
  }, [dismissToast, toast.discard, toast.duration, toast.id]);

  return (
    <div
      className={`cfg-toast cfg-toast--${toast.severity}`}
      role={toast.severity === 'error' ? 'alert' : 'status'}
      aria-live={toast.severity === 'error' ? 'assertive' : 'polite'}
    >
      <span className="cfg-toast__icon" aria-hidden="true">
        {toast.severity === 'info' && '✓'}
        {toast.severity === 'warning' && '!'}
        {toast.severity === 'error' && '×'}
      </span>
      <span className="cfg-toast__message">{toast.message}</span>
      <CloseButton
        tone="config"
        className="cfg-toast__close"
        label="Dismiss notification"
        onClick={() => dismissToast(toast.id)}
      />
    </div>
  );
}

/** Editor notifications, intentionally styled independently from operator HMI toasts. */
export function ConfigToastStack() {
  const toasts = useHmiStore((s) => s.pendingToasts);

  if (toasts.length === 0) return null;

  return (
    <div className="cfg-toast-stack" role="region" aria-label="Notifications">
      {toasts.map((toast) => (
        <ConfigToast key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
