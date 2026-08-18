import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { useVariablesDomainStore } from '@config/store/domains/variablesDomainStore';
import { useProjectStore } from '@shared/store/projectStore';
import type { DatasourceConfig, TreeNode } from '@shared/types/datasource';
import { isFolder } from '@shared/types/datasource';
import { collectFolderKeys } from '@config/components/ui/datasourceTreeHelpers';
import { normalizeArrayStructIndices } from './mutationHelpers';

interface ArrayShapeInfo {
  is_array: boolean;
  array_length?: number;
}

/** Build a map from node_id → array shape from the live config tree (all var
 *  nodes, so a scalar↔array transition on re-browse is captured too). */
function buildArrayShapeMap(nodes: TreeNode[]): Map<string, ArrayShapeInfo> {
  const map = new Map<string, ArrayShapeInfo>();
  function walk(ns: TreeNode[]) {
    for (const n of ns) {
      if (isFolder(n)) {
        walk(n.children);
      } else if (n.node_id) {
        map.set(n.node_id, { is_array: !!n.is_array, array_length: n.array_length });
      }
    }
  }
  walk(nodes);
  return map;
}

/** Overlay array shape from the live config into a possibly-stale draft tree. */
function patchArrayShape(draft: TreeNode[], map: Map<string, ArrayShapeInfo>): TreeNode[] {
  return draft.map((n) => {
    if (isFolder(n)) {
      return { ...n, children: patchArrayShape(n.children, map) };
    }
    const shape = n.node_id ? map.get(n.node_id) : undefined;
    if (!shape) return n;
    if (!shape.is_array) {
      const { array_length: _dropped, is_array: _isArr, ...rest } = n;
      return rest as TreeNode;
    }
    if (shape.array_length !== undefined) {
      return { ...n, is_array: true, array_length: shape.array_length };
    }
    const { array_length: _dropped, ...rest } = n;
    return { ...rest, is_array: true } as TreeNode;
  });
}

interface Params {
  datasource: DatasourceConfig | null;
  setVarsDraft: (name: string, tree: TreeNode[]) => void;
  clearVarsDraft: (name: string) => void;
  setCollapsedDraft: (name: string, collapsed: string[]) => void;
}

interface Result {
  tree: TreeNode[];
  setTree: Dispatch<SetStateAction<TreeNode[]>>;
  dirty: boolean;
  setDirty: Dispatch<SetStateAction<boolean>>;
  collapsed: Set<string>;
  setCollapsed: Dispatch<SetStateAction<Set<string>>>;
  latestTree: MutableRefObject<TreeNode[]>;
}

export function useDatasourceDraftLifecycle({
  datasource,
  setVarsDraft,
  clearVarsDraft,
  setCollapsedDraft,
}: Params): Result {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [dirty, setDirty] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const latestTree = useRef<TreeNode[]>(tree);
  latestTree.current = tree;

  const collapseInitialised = useRef(false);
  const hydratingFromConfig = useRef(false);
  const hydratedTree = useRef<TreeNode[] | null>(null);
  const hydratedCollapsed = useRef<Set<string> | null>(null);
  const dsName = datasource?.name ?? '';

  useEffect(() => {
    collapseInitialised.current = false;
  }, [dsName]);

  useEffect(() => {
    hydratingFromConfig.current = true;

    if (!datasource) {
      const empty: TreeNode[] = [];
      setTree(empty);
      hydratedTree.current = empty;
      setDirty(false);
      queueMicrotask(() => {
        hydratingFromConfig.current = false;
      });
      return;
    }

    const collapsedDraft = useVariablesDomainStore.getState().collapsedDrafts[datasource.name];
    if (Array.isArray(collapsedDraft)) {
      const restored = new Set(collapsedDraft);
      setCollapsed(restored);
      hydratedCollapsed.current = restored;
      collapseInitialised.current = true;
    }

    const treeDraft = useVariablesDomainStore.getState().varsDrafts[datasource.name];
    if (Array.isArray(treeDraft)) {
      const shapeMap = buildArrayShapeMap(datasource.variables ?? []);
      const patchedDraft = shapeMap.size > 0 ? patchArrayShape(treeDraft, shapeMap) : treeDraft;
      const normalizedDraft = normalizeArrayStructIndices(patchedDraft);
      setTree(normalizedDraft);
      hydratedTree.current = normalizedDraft;
      latestTree.current = normalizedDraft;
      setDirty(true);
      useProjectStore.getState().markDirty();
      if (!collapseInitialised.current && treeDraft.length > 0) {
        const restored = new Set(collectFolderKeys(treeDraft));
        setCollapsed(restored);
        hydratedCollapsed.current = restored;
        collapseInitialised.current = true;
      }
      queueMicrotask(() => {
        hydratingFromConfig.current = false;
      });
      return;
    }

    const vars = datasource.variables ?? [];
    const normalizedVars = normalizeArrayStructIndices(vars);
    setTree(normalizedVars);
    hydratedTree.current = normalizedVars;
    latestTree.current = normalizedVars;
    setDirty(false);
    if (!collapseInitialised.current && vars.length > 0) {
      const restored = new Set(collectFolderKeys(vars));
      setCollapsed(restored);
      hydratedCollapsed.current = restored;
      collapseInitialised.current = true;
    }

    queueMicrotask(() => {
      hydratingFromConfig.current = false;
    });
  }, [datasource]);

  useEffect(() => {
    if (hydratingFromConfig.current) return;
    if (tree === hydratedTree.current) return;
    if (!dsName) return;
    if (!dirty) {
      clearVarsDraft(dsName);
      return;
    }
    setVarsDraft(dsName, tree);
  }, [clearVarsDraft, dirty, dsName, setVarsDraft, tree]);

  useEffect(() => {
    if (hydratingFromConfig.current) return;
    if (collapsed === hydratedCollapsed.current) return;
    if (!collapseInitialised.current) return;
    if (!dsName) return;
    setCollapsedDraft(dsName, Array.from(collapsed));
  }, [collapsed, dsName, setCollapsedDraft]);

  return {
    tree,
    setTree,
    dirty,
    setDirty,
    collapsed,
    setCollapsed,
    latestTree,
  };
}
