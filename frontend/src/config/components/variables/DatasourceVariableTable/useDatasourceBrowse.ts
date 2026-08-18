import { useCallback, useState, type MutableRefObject } from 'react';
import type { TreeNode } from '@shared/types/datasource';
import { apiJson } from '@shared/utils/api';
import { buildFromBrowse, type BrowseNode } from '@config/components/ui/datasourceTreeHelpers';
import { useVariablesDomainStore } from '@config/store/domains/variablesDomainStore';
import { applyBrowseDiff, computeBrowseDiff, isEmptyDiff } from './datasourceBrowseDiff';

interface Params {
  dsName: string;
  latestTree: MutableRefObject<TreeNode[]>;
  applyTreeUpdate: (updater: (prev: TreeNode[]) => TreeNode[]) => void;
}

export function useDatasourceBrowse({ dsName, latestTree, applyTreeUpdate }: Params) {
  const setPendingBrowse = useVariablesDomainStore((s) => s.setPendingBrowse);
  const [browsing, setBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);

  const handleBrowse = useCallback(async () => {
    setBrowsing(true);
    setBrowseError(null);

    try {
      const root = await apiJson<BrowseNode & { show_root?: boolean }>(
        `/api/datasources/${encodeURIComponent(dsName)}/browse`,
      );

      // The user may have switched to a different datasource while this
      // browse was in flight — latestTree/applyTreeUpdate are shared across
      // datasources (the table isn't remounted per selection), so diffing
      // this datasource's server nodes against whatever tree happens to be
      // loaded now would be nonsensical (§3.2).
      if (useVariablesDomainStore.getState().selectedName !== dsName) return;

      const items = root.show_root ? [root] : (root.children ?? []);
      // Build browse tree with enabled=false everywhere; "added" rows aren't
      // applied until the user accepts them, and we don't want to leak the
      // saved tree's enabled state into the diff comparison.
      const browseTree = buildFromBrowse(items, new Map());

      const savedTree = latestTree.current;
      const diff = computeBrowseDiff(savedTree, browseTree);

      // Silent reactivations are server-state corrections, not user-reviewable
      // choices — apply them immediately so Discard can't strand a var as
      // stale after we've already seen it back on the server.
      if (diff.silentReactivations.length > 0) {
        applyTreeUpdate((prev) =>
          applyBrowseDiff({
            savedTree: prev,
            diff: {
              added: [],
              removed: [],
              modified: [],
              silentReactivations: diff.silentReactivations,
            },
            selected: new Set(),
          }),
        );
      }

      if (isEmptyDiff(diff)) return;

      setPendingBrowse(dsName, { diff });
    } catch (error: unknown) {
      setBrowseError(error instanceof Error ? error.message : String(error));
    } finally {
      setBrowsing(false);
    }
  }, [applyTreeUpdate, dsName, latestTree, setPendingBrowse]);

  return { browsing, browseError, handleBrowse };
}
