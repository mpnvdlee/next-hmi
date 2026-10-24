import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { TreeNode } from '@shared/types/datasource';
import { apiNdjson } from '@shared/utils/api';
import { buildFromBrowse, type BrowseNode } from '@config/components/ui/datasourceTreeHelpers';
import { useVariablesDomainStore } from '@config/store/domains/variablesDomainStore';
import { applyBrowseDiff, computeBrowseDiff, isEmptyDiff } from './datasourceBrowseDiff';

interface Params {
  dsName: string;
  latestTree: MutableRefObject<TreeNode[]>;
  applyTreeUpdate: (updater: (prev: TreeNode[]) => TreeNode[]) => void;
}

export interface BrowseProgress {
  /** 0–99 while the walk runs, never decreasing; null before the first report. */
  percent: number | null;
  /** Nodes found so far. */
  nodes: number;
  /** Browse rounds so far — how deep the walk has reached. */
  level: number;
}

type BrowseRoot = BrowseNode & { show_root?: boolean; present_outside_browse?: string[] };

type BrowseLine =
  | { type: 'progress'; done: number; total: number; nodes: number; level: number }
  | { type: 'result'; tree: BrowseRoot }
  | { type: 'error'; error: string };

/**
 * The bar position for a progress report.
 *
 * The server reports work done against work known *so far* — an address
 * space's size is unknown until it has been walked — so the ratio can dip
 * when a level reveals a large subtree. The bar holds rather than jump back.
 * It also stops at 99 until the tree is in hand: after the last report the
 * whole tree still has to be serialised and sent.
 */
export function nextBrowsePercent(previous: number | null, done: number, total: number): number {
  const raw = total > 0 ? Math.floor((done / total) * 100) : 0;
  return Math.max(previous ?? 0, Math.min(raw, 99));
}

export function useDatasourceBrowse({ dsName, latestTree, applyTreeUpdate }: Params) {
  const setPendingBrowse = useVariablesDomainStore((s) => s.setPendingBrowse);
  const [browsing, setBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [progress, setProgress] = useState<BrowseProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // A full browse can run for minutes. Leaving the datasource, or the page,
  // closes the stream — which cancels the walk on the server too, instead of
  // leaving it to finish for nobody.
  useEffect(() => () => abortRef.current?.abort(), [dsName]);

  const handleBrowse = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBrowsing(true);
    setBrowseError(null);
    setProgress({ percent: null, nodes: 0, level: 0 });

    try {
      // Filled from inside the line callback — a holder, because TypeScript
      // does not see assignments to a plain `let` made in a closure.
      const received: { root: BrowseRoot | null; failure: string | null } = {
        root: null,
        failure: null,
      };
      await apiNdjson<BrowseLine>(
        `/api/datasources/${encodeURIComponent(dsName)}/browse/stream`,
        (line) => {
          if (line.type === 'progress') {
            setProgress((prev) => ({
              percent: nextBrowsePercent(prev?.percent ?? null, line.done, line.total),
              nodes: line.nodes,
              level: line.level,
            }));
          } else if (line.type === 'result') {
            received.root = line.tree;
          } else if (line.type === 'error') {
            received.failure = line.error;
          }
        },
        { signal: controller.signal },
      );
      if (received.failure) throw new Error(received.failure);
      const browsed = received.root;
      if (!browsed) throw new Error('The browse ended without a result.');

      // The user may have switched to a different datasource while this
      // browse was in flight — latestTree/applyTreeUpdate are shared across
      // datasources (the table isn't remounted per selection), so diffing
      // this datasource's server nodes against whatever tree happens to be
      // loaded now would be nonsensical.
      if (useVariablesDomainStore.getState().selectedName !== dsName) return;

      const items = browsed.show_root ? [browsed] : (browsed.children ?? []);
      // Build browse tree with enabled=false everywhere; "added" rows aren't
      // applied until the user accepts them, and we don't want to leak the
      // saved tree's enabled state into the diff comparison.
      const browseTree = buildFromBrowse(items, new Map());

      const savedTree = latestTree.current;
      const diff = computeBrowseDiff(
        savedTree,
        browseTree,
        new Set(browsed.present_outside_browse ?? []),
      );

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
      if (controller.signal.aborted) return;
      setBrowseError(error instanceof Error ? error.message : String(error));
    } finally {
      // Only the browse that is still current may clear the shared state; an
      // aborted one finishing late must not hide a newer browse's bar.
      if (abortRef.current === controller) {
        setBrowsing(false);
        setProgress(null);
      }
    }
  }, [applyTreeUpdate, dsName, latestTree, setPendingBrowse]);

  return { browsing, browseError, progress, handleBrowse };
}
