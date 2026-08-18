import type { AlarmLevel } from '@shared/types/alarm';
import { useHmiStore } from '@hmi/store/hmiStore';
import { useHmiScope } from '@hmi/context/HmiScopeContext';
import { useTranslationStore } from '@shared/store/translationStore';
import { apiJson, errorMessage } from '@shared/utils/api';
import './alarmShared.css';

/**
 * Resolver for an alarm instance's title / description.
 *
 * Those two fields reach the client already flattened to a plain string, so a
 * `$loc` value arrives as its bare key (`AlarmDefinition.resolve_string`,
 * `backend/models/alarm.py`). That is deliberate — one instance is broadcast to
 * every client and stored in history, so it stays language-agnostic and the
 * operator's language is applied here, at render. `resolve` hands back the key
 * unchanged when no entry matches, so a literal string passes through untouched.
 *
 * `resolutions` need none of this: the backend forwards them as raw property
 * values, so `AlarmDetailDialog` evaluates their `$loc` through the normal
 * evaluation context.
 *
 * `resolve` reads live store state, so it never goes stale on its own — but a
 * component that only called it would never re-render on a language switch. The
 * two bare subscriptions below exist for that: they are what changes underneath
 * `resolve`, so reading them is what keeps alarm surfaces in the current
 * language rather than the one that was active when they mounted.
 */
export function useAlarmText(): (text: string) => string {
  const resolve = useTranslationStore((s) => s.resolve);
  useTranslationStore((s) => s.activeLanguage);
  useTranslationStore((s) => s.translations);
  return resolve;
}

/** Returns the current HMI actor username, falling back to 'operator'. */
export function useAlarmUsername(): string {
  const scope = useHmiScope();
  const currentUser = useHmiStore((s) => s.currentUsersByScope[scope]);
  return currentUser?.username || 'operator';
}

/**
 * Class that publishes a severity as `--hmi-alarm-level` on an alarm surface —
 * a table row, a toast, a standalone dot. Every severity-driven declaration in
 * `alarmShared.css` reads that one property, so this is the only place a
 * level maps to a colour.
 */
export function alarmLevelClass(level: AlarmLevel): string {
  return (
    {
      error: 'hmi-alarm-level--error',
      warning: 'hmi-alarm-level--warning',
      info: 'hmi-alarm-level--info',
    }[level] || ''
  );
}

/** Composed class string for an alarm level indicator dot. */
export function levelDotClass(level: AlarmLevel): string {
  return `hmi-pill__dot hmi-alarm-dot ${alarmLevelClass(level)}`;
}

/**
 * Format an ISO timestamp as a short time string (HH:MM:SS).
 * Used in active alarm lists.
 */
export function formatAlarmTimeShort(iso: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Format an ISO timestamp as a full locale date and time string.
 * Used in alarm history rows and detail dialogs.
 */
export function formatAlarmDateTime(iso: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

export interface AckAlarmOptions {
  /**
   * How a refused acknowledgement is surfaced. `'toast'` (the default) shows one
   * error toast; `'silent'` swallows it; a function receives the raw reason.
   */
  onError?: 'toast' | 'silent' | ((reason: string) => void);
}

const ACK_TOAST_DURATION_MS = 4000;

/**
 * Report a refused acknowledgement, per `useWriteVariable`'s error contract.
 *
 * The toast stays inside the helper for the same reason it does there:
 * `showToast` is not on the custom-widget SDK, so a widget author who only
 * awaits the call has no way to tell the operator anything — and a rejected ack
 * that nobody catches leaves the alarm unacknowledged with no feedback at all.
 *
 * `toastId` is stable per ack target and deduped against `pendingToasts`, so an
 * operator hammering an ACK button reuses that toast instead of stacking one per
 * press. Per target rather than global, so two alarms refused for different
 * reasons each still get to say so.
 */
function reportAckFailure(
  err: unknown,
  toastId: string,
  onError: NonNullable<AckAlarmOptions['onError']>,
): void {
  if (onError === 'silent') return;
  const reason = errorMessage(err);
  if (typeof onError === 'function') {
    onError(reason);
    return;
  }
  const { pendingToasts, showToast } = useHmiStore.getState();
  if (pendingToasts.some((t) => t.id === toastId)) return;
  showToast({
    id: toastId,
    message: `Could not acknowledge: ${reason}`,
    severity: 'error',
    discard: 'auto',
    duration: ACK_TOAST_DURATION_MS,
  });
}

async function postAck(
  url: string,
  username: string,
  toastId: string,
  options: AckAlarmOptions | undefined,
): Promise<boolean> {
  try {
    await apiJson(url, { method: 'POST', body: { username } });
    return true;
  } catch (err) {
    reportAckFailure(err, toastId, options?.onError ?? 'toast');
    return false;
  }
}

/**
 * Acknowledge a single alarm instance via the REST API.
 *
 * Resolves `true` when the backend accepted it and `false` when it refused —
 * it never rejects, so a caller that ignores the result still gets the refusal
 * on screen. Sequence anything that must only happen on success (closing a
 * dialog, say) on the returned value.
 */
export async function ackAlarm(
  instanceId: string,
  username: string,
  options?: AckAlarmOptions,
): Promise<boolean> {
  return postAck(
    `/api/alarms/ack/${encodeURIComponent(instanceId)}`,
    username,
    `alarm-ack-${instanceId}`,
    options,
  );
}

/** Acknowledge all active alarms via the REST API. Same contract as `ackAlarm`. */
export async function ackAllAlarms(username: string, options?: AckAlarmOptions): Promise<boolean> {
  return postAck('/api/alarms/ack-all', username, 'alarm-ack-all', options);
}
