import { useState, useCallback, useEffect } from 'react';
import type { AlarmInstance } from '@shared/types/alarm';
import { useAlarmStore } from '@hmi/store/alarmStore';
import { ackAlarm, useAlarmText, useAlarmUsername } from '../alarmUtils';
import AlarmDetailDialog from '../AlarmDetailDialog';
import AlarmToastCard from './AlarmToastCard';
import styles from './index.module.css';

/**
 * AlarmPopup renders toast-like notifications in top-right for auto_popup alarms
 * that have not been acknowledged. Clicking opens the detail dialog.
 * Dismissing hides the popup locally without acknowledging.
 */
export default function AlarmPopup() {
  const active = useAlarmStore((s) => s.active);
  const username = useAlarmUsername();
  const alarmText = useAlarmText();

  // Track locally dismissed popup IDs (not acked, just hidden)
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [detailAlarm, setDetailAlarm] = useState<AlarmInstance | null>(null);

  // Clean dismissed set when alarms disappear (cleared by backend)
  useEffect(() => {
    const currentIds = new Set(active.map((a) => a.id));
    setDismissed((prev) => {
      const next = new Set<string>();
      for (const id of prev) {
        if (currentIds.has(id)) next.add(id);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [active]);

  const popupAlarms = active.filter((a) => a.auto_popup && !a.acked && !dismissed.has(a.id));

  const handleDismiss = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setDismissed((prev) => new Set(prev).add(id));
  }, []);

  const handleAck = useCallback(
    async (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      await ackAlarm(id, username);
    },
    [username],
  );

  if (popupAlarms.length === 0 && !detailAlarm) return null;

  return (
    <>
      <div className={styles.overlay}>
        {popupAlarms.slice(0, 5).map((alarm) => (
          <AlarmToastCard
            key={alarm.id}
            level={alarm.level}
            code={alarm.code}
            title={alarmText(alarm.title)}
            onClick={() => setDetailAlarm(alarm)}
            onAck={(e) => handleAck(e, alarm.id)}
            onDismiss={(e) => handleDismiss(e, alarm.id)}
          />
        ))}
      </div>

      {detailAlarm && (
        <AlarmDetailDialog
          alarm={detailAlarm}
          username={username}
          onClose={() => setDetailAlarm(null)}
        />
      )}
    </>
  );
}
