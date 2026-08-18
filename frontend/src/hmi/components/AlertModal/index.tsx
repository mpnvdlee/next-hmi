import { useHmiStore } from '@hmi/store/hmiStore';
import { executeWidgetActions } from '@hmi/utils/widgetActions';
import { useEvalContext } from '@hmi/hooks/useEvalContext';
import CloseButton from '@shared/components/CloseButton';

interface AlertModalProps {
  scope: string;
}

export function AlertModal({ scope }: AlertModalProps) {
  const alerts = useHmiStore((s) => s.pendingAlerts);
  const dismissAlert = useHmiStore((s) => s.dismissAlert);
  const evalCtx = useEvalContext();
  const alert = alerts[0];

  if (!alert) return null;

  // AlertModal renders outside any InputScopeContext, so override evalCtx with
  // the scope captured when the alert was fired.
  const replayCtx =
    alert.inputScopeProps !== undefined
      ? { ...evalCtx, inputScopeProps: alert.inputScopeProps }
      : evalCtx;

  function handleCancel() {
    dismissAlert(alert.id);
    executeWidgetActions(alert.onCancel, { scope, evalCtx: replayCtx });
  }

  function handleOk() {
    dismissAlert(alert.id);
    executeWidgetActions(alert.onOk, { scope, evalCtx: replayCtx });
  }

  function handleDismiss() {
    dismissAlert(alert.id);
  }

  return (
    <div className="hmi-alert-backdrop" onClick={alert.dismissible ? handleDismiss : undefined}>
      <div className="hmi-modal hmi-alert-modal" onClick={(e) => e.stopPropagation()}>
        <div className="hmi-modal__header">
          <span className="hmi-modal__title">{alert.title}</span>
          {alert.dismissible && (
            <CloseButton className="hmi-modal__close" onClick={handleDismiss} />
          )}
        </div>
        <div className="hmi-alert-modal__body">
          <p className="hmi-alert-modal__description">{alert.description}</p>
        </div>
        <div className="hmi-alert-modal__footer">
          <button
            type="button"
            className="hmi-alert-modal__btn hmi-alert-modal__btn--cancel"
            onClick={handleCancel}
          >
            {alert.cancelText}
          </button>
          <button
            type="button"
            className="hmi-alert-modal__btn hmi-alert-modal__btn--ok"
            onClick={handleOk}
          >
            {alert.okText}
          </button>
        </div>
      </div>
    </div>
  );
}
