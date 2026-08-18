import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { useProjectStore } from '@shared/store/projectStore';
import type { VariableEntry, TreeNode } from '@shared/types/datasource';
import {
  setEnabledInSubtree,
  updateVarInTree,
  collectFolderKeys,
} from '@config/components/ui/datasourceTreeHelpers';
import {
  appendFolder,
  appendFolderInFolder,
  appendVariable,
  appendVariableInFolder,
  appendArray,
  appendArrayInFolder,
  appendArrayStruct,
  appendArrayStructInFolder,
  changeArrayLength,
  normalizeArrayStructIndices,
  removeNodeByPath,
  setFolderEnabledByIdentity,
  renameFolderInTree,
  renameFolderCollapsedKeys,
} from './mutationHelpers';

interface Params {
  latestTree: MutableRefObject<TreeNode[]>;
  setTree: Dispatch<SetStateAction<TreeNode[]>>;
  setDirty: Dispatch<SetStateAction<boolean>>;
  setCollapsed: Dispatch<SetStateAction<Set<string>>>;
}

export function useDatasourceTreeMutations({
  latestTree,
  setTree,
  setDirty,
  setCollapsed,
}: Params) {
  const applyTreeUpdate = useCallback(
    (updater: (prev: TreeNode[]) => TreeNode[]) => {
      setTree((prev) => {
        const next = normalizeArrayStructIndices(updater(prev));
        latestTree.current = next;
        return next;
      });
      setDirty(true);
      useProjectStore.getState().markDirty();
    },
    [latestTree, setDirty, setTree],
  );

  const updateVar = useCallback(
    (path: string, nodeId: string | undefined, patch: Partial<VariableEntry>) => {
      applyTreeUpdate((prev) => updateVarInTree(prev, path, nodeId, patch));
    },
    [applyTreeUpdate],
  );

  const toggleFolder = useCallback(
    (key: string) => {
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    [setCollapsed],
  );

  const collapseAll = useCallback(() => {
    setCollapsed(new Set(collectFolderKeys(latestTree.current)));
  }, [latestTree, setCollapsed]);

  const expandAll = useCallback(() => {
    setCollapsed(new Set());
  }, [setCollapsed]);

  const addVariable = useCallback(
    (folderPath?: string) => {
      applyTreeUpdate((prev) =>
        folderPath ? appendVariableInFolder(prev, folderPath) : appendVariable(prev),
      );
    },
    [applyTreeUpdate],
  );

  const addFolder = useCallback(
    (folderPath?: string) => {
      applyTreeUpdate((prev) =>
        folderPath ? appendFolderInFolder(prev, folderPath) : appendFolder(prev),
      );
    },
    [applyTreeUpdate],
  );

  const addArray = useCallback(
    (folderPath?: string) => {
      applyTreeUpdate((prev) =>
        folderPath ? appendArrayInFolder(prev, folderPath) : appendArray(prev),
      );
    },
    [applyTreeUpdate],
  );

  const renameFolder = useCallback(
    (folderPath: string, newName: string) => {
      applyTreeUpdate((prev) => renameFolderInTree(prev, folderPath, newName));
      setCollapsed((prev) => renameFolderCollapsedKeys(prev, folderPath, newName));
    },
    [applyTreeUpdate, setCollapsed],
  );

  const addArrayStruct = useCallback(
    (folderPath?: string) => {
      applyTreeUpdate((prev) =>
        folderPath ? appendArrayStructInFolder(prev, folderPath) : appendArrayStruct(prev),
      );
    },
    [applyTreeUpdate],
  );

  const updateArrayLength = useCallback(
    (path: string, newLength: number) => {
      applyTreeUpdate((prev) => changeArrayLength(prev, path, newLength));
    },
    [applyTreeUpdate],
  );

  const removeNode = useCallback(
    (path: string) => {
      applyTreeUpdate((prev) => removeNodeByPath(prev, path));
    },
    [applyTreeUpdate],
  );

  const setFolderEnabled = useCallback(
    (path: string, nodeId: string | undefined, enabled: boolean) => {
      applyTreeUpdate((prev) =>
        setFolderEnabledByIdentity(prev, path, nodeId, enabled, setEnabledInSubtree),
      );
    },
    [applyTreeUpdate],
  );

  return {
    applyTreeUpdate,
    updateVar,
    toggleFolder,
    collapseAll,
    expandAll,
    addVariable,
    addFolder,
    addArray,
    addArrayStruct,
    updateArrayLength,
    removeNode,
    renameFolder,
    setFolderEnabled,
  };
}
