import type { AlarmLevel } from '@shared/types/alarm';
import CloseButton from '@shared/components/CloseButton';
import '../ToastStack/toast-stack.css';
import styles from './index.module.css';

/** Same glyph set the general toast stack uses, so both read as one system. */
const LEVEL_GLYPH: Record<AlarmLevel, string> = {
  error: '✕',
  warning: '▲',
  info: '●',
};

interface AlarmToastCardProps {
  level: AlarmLevel;
  code?: string;
  title: string;
  onClick?: () => void;
  onAck?: (e: React.MouseEvent) => void;
  onDismiss?: (e: React.MouseEvent) => void;
  /** Renders the controls inert — for the alarm editor's preview of this card. */
  disabled?: boolean;
}

/**
 * The alarm notification card itself, shared by the operator runtime
 * (`AlarmPopup`) and the alarm editor's preview panel — one markup and one set
 * of styles, so what a builder previews is what an operator sees.
 */
export default function AlarmToastCard({
  level,
  code,
  title,
  onClick,
  onAck,
  onDismiss,
  disabled = false,
}: AlarmToastCardProps) {
  return (
    <div
      className={`hmi-toast hmi-toast--${level} ${styles.popup}${
        disabled ? ` ${styles.popupInert}` : ''
      }`}
      onClick={disabled ? undefined : onClick}
    >
      <span className="hmi-toast__icon" aria-hidden="true">
        {LEVEL_GLYPH[level]}
      </span>
      <div className={styles.popupContent}>
        <div className={styles.popupTitle}>{code ? `[${code}] ${title}` : title}</div>
        <div className={styles.popupMeta}>{level}</div>
      </div>
      <button className={styles.ackBtn} onClick={onAck} disabled={disabled}>
        ACK
      </button>
      <CloseButton
        className="hmi-toast__close"
        onClick={onDismiss}
        disabled={disabled}
        label={disabled ? 'Close alarm preview' : 'Dismiss alarm'}
      />
    </div>
  );
}
