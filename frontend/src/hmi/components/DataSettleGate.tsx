import { useEffect, useState, type ReactNode } from 'react';
import { DataSettleContext } from '../context/DataSettleContext';
import { useVariableStore } from '../store/variableStore';

/** Fallback for a `done` signal that never comes — the backend is down, the
 *  build is older than `context_ready`, the surface has no ack of its own. Long
 *  enough that a merely slow datasource finishes first and nothing is marked. */
export const NO_DATA_GRACE_MS = 3000;

interface DataSettleGateProps {
  /** Identifies the load being waited on — a page id, a dialog id. A new key
   *  reopens the window, so a timer from the page navigated away from cannot
   *  close the window for the page navigated to. */
  settleKey: string | undefined;
  /** True once this surface's data has been delivered as far as it will be.
   *  For a page that is `context_ready` echoing its id: the client applies it
   *  behind the value frames it acks, so the values are already in the store. */
  done: boolean;
  children: ReactNode;
}

/**
 * Holds the binding overlays off a subtree until its data has settled — the
 * backend said it sent everything it could, or the grace ran out. A binding
 * still without a value at that point is genuinely without data, and only then
 * gets marked (amber, by `aggregateBindingStatus`).
 *
 * This is what lets the page reveal without waiting for the datasource at all:
 * the reveal is a config-and-code question (PageGroupPageView), the marking is
 * a data question, and they no longer have to share one spinner.
 */
export default function DataSettleGate({ settleKey, done, children }: DataSettleGateProps) {
  // The latch is per *wait*, not per key: a key that already spent its grace
  // once has to get a fresh one when it starts waiting again. Both ways in
  // matter — navigating back to a page visited earlier (this gate is long-lived
  // and never remounts between pages), and a reconnect clearing
  // `contextReadyPageIds` under the page that is already on screen. Keeping a
  // single `closedFor === settleKey` latch marked every valueless binding amber
  // the instant either happened, while the fresh `set_context` was still out.
  //
  // Reset during render rather than from an effect, so the new wait never gets
  // a frame of the previous one's verdict.
  const [wait, setWait] = useState<{ key: string | undefined; done: boolean; closed: boolean }>(
    () => ({ key: settleKey, done, closed: false }),
  );
  if (wait.key !== settleKey || wait.done !== done) {
    setWait({ key: settleKey, done, closed: false });
  }
  useEffect(() => {
    if (done || settleKey === undefined) return;
    const t = setTimeout(
      () => setWait((w) => (w.key === settleKey && !w.done ? { ...w, closed: true } : w)),
      NO_DATA_GRACE_MS,
    );
    return () => clearTimeout(t);
  }, [settleKey, done]);
  const settling = !done && settleKey !== undefined && !wait.closed;
  return <DataSettleContext.Provider value={settling}>{children}</DataSettleContext.Provider>;
}

/**
 * The gate for a surface whose settle signal is the backend's `context_ready`
 * echoing its own id — a runtime or preview page, an open page overlay, an open
 * dialog. One place decides how that ack is read, rather than each caller
 * re-deriving it from the store.
 *
 * A dialog's variables ride the same `set_context` as its page's (the backend
 * folds `openDialogIds` into one key set and echoes both lists back), so it
 * settles on the ack too rather than sitting out the grace.
 */
export function PageDataSettleGate({
  pageId,
  kind = 'page',
  children,
}: {
  pageId: string | undefined;
  kind?: 'page' | 'dialog';
  children: ReactNode;
}) {
  const done = useVariableStore((s) => {
    if (pageId === undefined) return false;
    const ids = kind === 'dialog' ? s.contextReadyDialogIds : s.contextReadyPageIds;
    return ids.includes(pageId);
  });
  return (
    <DataSettleGate settleKey={pageId} done={done}>
      {children}
    </DataSettleGate>
  );
}
