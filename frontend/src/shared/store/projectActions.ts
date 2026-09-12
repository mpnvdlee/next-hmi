import { useProjectStore } from './projectStore';

export function projectIsDirty(): boolean {
  return useProjectStore.getState().dirty;
}

export function projectMarkDirty(): void {
  useProjectStore.getState().markDirty();
}

export function projectSnapshotAndDirty(): void {
  const ps = useProjectStore.getState();
  ps.pushSnapshot();
  ps.markDirty();
}

/**
 * Snapshot for a high-frequency write — a keystroke, a slider drag. The first
 * call in a window opens an undo step and every call after it folds into that
 * one. The window is shared by every editor rather than kept per store: two
 * views cannot take the same keystroke, and one window keeps a burst from
 * splitting into two steps when the user crosses from one editor to the other.
 */
let lastThrottledSnapshot = 0;

export function projectThrottledSnapshotAndDirty(ms = 500): void {
  const now = Date.now();
  if (now - lastThrottledSnapshot > ms) {
    useProjectStore.getState().pushSnapshot();
    lastThrottledSnapshot = now;
  }
  projectMarkDirty();
}

export function projectClearHistory(): void {
  useProjectStore.setState({ past: [], future: [] });
}
