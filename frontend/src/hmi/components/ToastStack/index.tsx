import { useEffect } from 'react';
import type { ToastEntry } from '@hmi/store/hmiStore';
import { useHmiStore } from '@hmi/store/hmiStore';
import CloseButton from '@shared/components/CloseButton';
import './toast-stack.css';

function Toast({ toast }: { toast: ToastEntry }) {
  const dismissToast = useHmiStore((s) => s.dismissToast);

  useEffect(() => {
    if (toast.discard !== 'auto') return;
    const timer = setTimeout(() => {
      dismissToast(toast.id);
    }, toast.duration);
    return () => {
      clearTimeout(timer);
    };
  }, [toast.id, toast.discard, toast.duration, dismissToast]);

  return (
    <div
      className={`hmi-toast hmi-toast--${toast.severity}`}
      role="alert"
      aria-live={toast.severity === 'error' ? 'assertive' : 'polite'}
    >
      <span className="hmi-toast__icon" aria-hidden="true">
        {toast.severity === 'info' && '●'}
        {toast.severity === 'warning' && '▲'}
        {toast.severity === 'error' && '✕'}
      </span>
      <span className="hmi-toast__message">{toast.message}</span>
      <CloseButton
        className="hmi-toast__close"
        label="Dismiss notification"
        onClick={() => dismissToast(toast.id)}
      />
    </div>
  );
}

/** Operator-facing notifications. Their appearance follows the active HMI theme. */
export function HmiToastStack() {
  const toasts = useHmiStore((s) => s.pendingToasts);

  if (toasts.length === 0) return null;

  return (
    <div className="hmi-toast-stack" role="region" aria-label="Notifications">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
