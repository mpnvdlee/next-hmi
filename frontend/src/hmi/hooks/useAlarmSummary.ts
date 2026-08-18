import { useAlarmStore } from '@hmi/store/alarmStore';
import type { AlarmSummary } from '@shared/types/alarm';

/**
 * Live alarm counts, as pushed over the WebSocket alongside the active list.
 *
 * Exposed on the custom-widget SDK next to `useActiveAlarms` so a project can
 * render its own alarm banner or badge without subscribing to the store.
 */
export function useAlarmSummary(): AlarmSummary {
  return useAlarmStore((s) => s.summary);
}
