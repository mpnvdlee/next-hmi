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

export function projectClearHistory(): void {
  useProjectStore.setState({ past: [], future: [] });
}
