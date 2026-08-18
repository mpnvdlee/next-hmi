import { useSyncExternalStore } from 'react';

/**
 * Shared one-second ticker for `$time` expressions.
 *
 * A single module-level interval drives every subscriber, and it only runs while
 * at least one widget is subscribed. Unlike the old view-level `useSecondTick`
 * (which re-rendered the whole page tree every second just so a handful of
 * `$time` widgets could refresh), this lets each widget opt in individually:
 * pass `active = usesTime(...)` and only time-bound widgets re-render per tick.
 */

let tick = 0;
const listeners = new Set<() => void>();
let intervalId: ReturnType<typeof setInterval> | null = null;

function start(): void {
  if (intervalId != null) return;
  intervalId = setInterval(() => {
    tick += 1;
    for (const l of listeners) l();
  }, 1000);
}

function stop(): void {
  if (intervalId == null) return;
  clearInterval(intervalId);
  intervalId = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

const getTick = () => tick;

const noopSubscribe = () => () => {};

/**
 * Re-render the calling widget once per second, but only when `active` is true.
 * When inactive the hook subscribes to nothing, so the widget never re-renders
 * on the tick (and the shared interval stays stopped unless some other widget
 * needs it). The snapshot value itself is unused — the hook exists only for its
 * re-render side effect — so `getTick` serves both cases.
 */
export function useTimeTick(active: boolean): void {
  useSyncExternalStore(active ? subscribe : noopSubscribe, getTick, getTick);
}
