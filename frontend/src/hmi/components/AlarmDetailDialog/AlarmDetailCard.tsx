import type { ReactNode } from 'react';
import type { AlarmLevel } from '@shared/types/alarm';
import CloseButton from '@shared/components/CloseButton';
import styles from './index.module.css';

const LEVEL_BADGE: Record<AlarmLevel, string> = {
  error: styles.levelError,
  warning: styles.levelWarning,
  info: styles.levelInfo,
};

interface AlarmDetailCardProps {
  level: AlarmLevel;
  code?: string;
  title: string;
  /** Ready-to-use image URL — the runtime and the editor resolve assets differently. */
  imageSrc?: string;
  description?: string;
  /** Stands in for a missing description; only the editor preview passes one. */
  descriptionPlaceholder?: string;
  resolutions?: string[];
  /** The mono fact lines under the body — timestamps, who acknowledged. */
  meta?: ReactNode;
  className?: string;
  onAck?: () => void;
  onClose?: () => void;
  /** Renders the controls inert — for the alarm editor's preview of this card. */
  disabled?: boolean;
}

/**
 * The alarm detail card, shared by the operator runtime (`AlarmDetailDialog`
 * wraps it in a modal overlay) and the alarm editor's preview panel, which
 * renders it inline. One markup and one set of styles, so what a builder
 * previews is what an operator sees.
 */
export default function AlarmDetailCard({
  level,
  code,
  title,
  imageSrc,
  description,
  descriptionPlaceholder,
  resolutions,
  meta,
  className = '',
  onAck,
  onClose,
  disabled = false,
}: AlarmDetailCardProps) {
  return (
    <div className={`${styles.dialog} ${className}`.trim()}>
      <div className={styles.dialogHeader}>
        <span className={`${styles.levelBadge} ${LEVEL_BADGE[level]}`}>
          <i className="hmi-pill__dot" aria-hidden="true" />
          {level}
        </span>
        <span className={styles.dialogTitle}>{title}</span>
        {code && <span className={styles.code}>{code}</span>}
        <CloseButton
          className="hmi-modal__close"
          onClick={onClose}
          disabled={disabled}
          label={disabled ? 'Close alarm detail preview' : 'Close'}
        />
      </div>

      <div className={`${styles.dialogBody} ${imageSrc ? styles.dialogBodyTwoCol : ''}`}>
        {imageSrc && (
          <div className={styles.imageCol}>
            <img className={styles.image} src={imageSrc} alt={title} />
          </div>
        )}
        <div className={styles.infoCol}>
          {description ? (
            <div className={styles.description}>{description}</div>
          ) : (
            descriptionPlaceholder && (
              <div className={styles.descriptionEmpty}>{descriptionPlaceholder}</div>
            )
          )}

          {resolutions && resolutions.length > 0 && (
            <div className={styles.resolutions}>
              <div className={styles.resolutionsTitle}>Resolutions</div>
              {resolutions.map((r, i) => (
                <div key={i} className={styles.resolutionItem}>
                  – {r}
                </div>
              ))}
            </div>
          )}

          {meta && <div className={styles.meta}>{meta}</div>}
        </div>
      </div>

      {/* An acknowledged alarm has no action left, and an empty footer band
          reads as a control that failed to render. */}
      {(onAck || disabled) && (
        <div className={styles.dialogFooter}>
          <button className={styles.ackBtn} onClick={onAck} disabled={disabled}>
            Acknowledge
          </button>
        </div>
      )}
    </div>
  );
}
