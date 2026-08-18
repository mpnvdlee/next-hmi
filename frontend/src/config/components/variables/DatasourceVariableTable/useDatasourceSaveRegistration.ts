import { useCallback, useEffect, type MutableRefObject } from 'react';
import { useProjectStore } from '@shared/store/projectStore';
import { apiJson } from '@shared/utils/api';
import type { TreeNode } from '@shared/types/datasource';

interface Params {
  dsName: string;
  latestTree: MutableRefObject<TreeNode[]>;
  dirtyRef: MutableRefObject<boolean>;
  clearVarsDraft: (name: string) => void;
  onVariablesChange: (variables: TreeNode[]) => void;
  setDirty: (value: boolean) => void;
}

export function useDatasourceSaveRegistration({
  dsName,
  latestTree,
  dirtyRef,
  clearVarsDraft,
  onVariablesChange,
  setDirty,
}: Params) {
  const handleSave = useCallback(async () => {
    // Snapshot the tree actually being sent — `latestTree.current` may move
    // on if the user keeps editing while the PUT is in flight (§3.1).
    const sentTree = latestTree.current;
    try {
      await apiJson(`/api/datasources/${encodeURIComponent(dsName)}/variables`, {
        method: 'PUT',
        body: sentTree,
      });
      if (latestTree.current !== sentTree) {
        // A newer edit landed while this save was in flight. Keep `dirty`
        // true and don't overwrite local state with a refresh that only
        // reflects the older, already-superseded PUT — the next save sends
        // the newer tree.
        return;
      }
      setDirty(false);
      clearVarsDraft(dsName);
      onVariablesChange(sentTree);
    } catch (e) {
      console.error('[useDatasourceSaveRegistration] save failed:', e);
      throw e;
    }
  }, [clearVarsDraft, dsName, latestTree, onVariablesChange, setDirty]);

  useEffect(() => {
    if (!dsName) return;

    const key = `ds-vars-${dsName}`;
    useProjectStore.getState().registerSave(key, async () => {
      if (!dirtyRef.current) return;
      await handleSave();
    });

    return () => {
      useProjectStore.getState().unregisterSave(key);
    };
  }, [dirtyRef, dsName, handleSave]);
}
