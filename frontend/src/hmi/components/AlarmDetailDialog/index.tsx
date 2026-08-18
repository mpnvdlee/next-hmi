import { useCallback } from 'react';
import type { AlarmInstance } from '@shared/types/alarm';
import { ackAlarm, formatAlarmDateTime, useAlarmText } from '../alarmUtils';
import { imageAssetUrl } from '@shared/utils/imageAsset';
import { useReactiveEval } from '@hmi/hooks/useReactiveEval';
import { evaluatePropertyValue } from '@hmi/utils/propertySourceEval';
import AlarmDetailCard from './AlarmDetailCard';
import styles from './index.module.css';

interface AlarmDetailDialogProps {
  alarm: AlarmInstance;
  username: string;
  onClose: () => void;
}

export default function AlarmDetailDialog({ alarm, username, onClose }: AlarmDetailDialogProps) {
  // Dialog renders outside the widget tree, so subscribe to any `$var` / `$time`
  // a resolution string binds to (evalCtx no longer re-renders on ticks).
  const evalCtx = useReactiveEval(alarm.resolutions);
  const alarmText = useAlarmText();
  const resolutions = (alarm.resolutions ?? []).map((r) =>
    String(evaluatePropertyValue(r, evalCtx) ?? ''),
  );

  // A refused ack leaves the dialog open behind its toast — closing on a
  // failure would look exactly like success.
  const handleAck = useCallback(async () => {
    if (await ackAlarm(alarm.id, username)) onClose();
  }, [alarm.id, username, onClose]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  return (
    <div className={styles.overlay} onClick={handleOverlayClick}>
      <AlarmDetailCard
        className={styles.dialogFloating}
        level={alarm.level}
        code={alarm.code}
        title={alarmText(alarm.title)}
        imageSrc={alarm.image ? imageAssetUrl(alarm.image) : undefined}
        description={alarm.description ? alarmText(alarm.description) : undefined}
        resolutions={resolutions}
        meta={
          <>
            <span>Triggered: {formatAlarmDateTime(alarm.triggered_at)}</span>
            {alarm.acked && (
              <>
                <span>Acknowledged by: {alarm.acked_by}</span>
                <span>Acknowledged at: {formatAlarmDateTime(alarm.acked_at)}</span>
              </>
            )}
          </>
        }
        onAck={alarm.acked ? undefined : handleAck}
        onClose={onClose}
      />
    </div>
  );
}
