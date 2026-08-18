import { useAlarmStore } from '@hmi/store/alarmStore';
import type { AlarmInstance } from '@shared/types/alarm';

/**
 * The live active-alarm list, as pushed over the WebSocket.
 *
 * Exposed on the custom-widget SDK so a project can render its own alarm
 * presentation without reimplementing the transport. Acknowledging is a
 * separate call — `ackAlarm` / `ackAllAlarms`, also on the SDK.
 */
export function useActiveAlarms(): AlarmInstance[] {
  return useAlarmStore((s) => s.active);
}
