import { useCallback, useEffect, useRef, useState } from 'react';
import { apiJson } from '@shared/utils/api';
import type { BrowseNode } from '@config/components/ui/datasourceTreeHelpers';
import { browseTopLevel, isBrowseLeaf, withBrowseChildren } from './browseMerge';
import { isUnloaded } from './plcRows';

export type BrowseMode = 'marked' | 'lazy' | 'all';

type BrowseResult = BrowseNode & { show_root?: boolean; browse_mode?: BrowseMode };

// Open saved folders each need their lazy level (Expand all opens hundreds):
// that many ADS requests at once would swamp the PLC, so they queue.
const MAX_LEVEL_FETCHES = 4;

function browseUrl(dsName: string, nodeId?: string): string {
  const base = `/api/datasources/${encodeURIComponent(dsName)}/browse`;
  return nodeId ? `${base}?node_id=${encodeURIComponent(nodeId)}` : base;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function folderIds(nodes: BrowseNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (!isBrowseLeaf(node)) {
      out.push(node.node_id);
      folderIds(node.children ?? [], out);
    }
  }
  return out;
}

/** The folders a browse root was split into (`browseTopLevel`), down to and
 *  including the root itself — what opens first, so its level shows. */
function rootPathIds(top: BrowseNode[], rootId: string): string[] {
  const ids: string[] = [];
  let node: BrowseNode | undefined = top[0];
  while (node) {
    ids.push(node.node_id);
    if (node.node_id === rootId) break;
    node = node.children?.[0];
  }
  return ids;
}

function withId(set: ReadonlySet<string>, id: string, present: boolean): Set<string> {
  const next = new Set(set);
  if (present) next.add(id);
  else next.delete(id);
  return next;
}

/**
 * The PLC side of an ADS datasource's table: browsed once `active` turns on
 * and kept until `refresh` or another datasource. A marked or full browse
 * arrives as one tree; a lazy one a level at a time, a folder loading its own
 * level when it is first opened (or asked for with `ensureLoaded`).
 */
export function useAdsPlcBrowse(dsName: string, active: boolean) {
  const [nodes, setNodes] = useState<BrowseNode[] | null>(null);
  const [mode, setMode] = useState<BrowseMode>('marked');
  // What the browse itself returned, below any root folders added around it.
  const [found, setFound] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());
  const [generation, setGeneration] = useState(0);
  // The browse a response belongs to: one for another datasource or an
  // earlier generation is dropped.
  const current = useRef('');
  const fetched = useRef('');

  useEffect(() => {
    const key = `${dsName}#${generation}`;
    if (current.current !== key) {
      current.current = key;
      setNodes(null);
      setError(null);
      setOpen(new Set());
      setLoaded(new Set());
      setLoading(new Set());
    }
    if (!active || fetched.current === key) return;
    fetched.current = key;
    setError(null);
    apiJson<BrowseResult>(browseUrl(dsName))
      .then((root) => {
        if (current.current !== key) return;
        const top = browseTopLevel(root);
        const browseMode = root.browse_mode ?? 'marked';
        setMode(browseMode);
        setFound(root.children?.length ?? 0);
        setNodes(top);
        // A marked tree is small by design: open it all. A lazy or full one
        // opens only the root's own folders; the root's level is loaded.
        if (browseMode === 'marked') setOpen(new Set(folderIds(top)));
        else if (root.show_root) {
          setLoaded(new Set([root.node_id]));
          setOpen(new Set(rootPathIds(top, root.node_id)));
        }
      })
      .catch((err: unknown) => {
        if (current.current === key) {
          setError(errorText(err));
          // Let the next switch-on try again.
          fetched.current = '';
        }
      });
  }, [dsName, active, generation]);

  const loadLevel = useCallback(
    async (nodeId: string) => {
      const key = current.current;
      setError(null);
      setLoading((prev) => withId(prev, nodeId, true));
      try {
        const level = await apiJson<BrowseResult>(browseUrl(dsName, nodeId));
        if (current.current !== key) return;
        setLoaded((prev) => withId(prev, nodeId, true));
        setNodes((prev) => prev && withBrowseChildren(prev, nodeId, level.children ?? []));
      } catch (err) {
        if (current.current === key) {
          setError(errorText(err));
          // Opening the folder again retries it.
          requested.current.delete(nodeId);
        }
      } finally {
        if (current.current === key) setLoading((prev) => withId(prev, nodeId, false));
      }
    },
    [dsName],
  );

  // Levels asked for while their fetch is queued or runs are not fetched twice.
  const requested = useRef(new Set<string>());
  const queue = useRef<string[]>([]);
  const running = useRef(0);
  useEffect(() => {
    requested.current = new Set();
    queue.current = [];
  }, [dsName, generation]);
  const pump = useRef(() => {});
  pump.current = () => {
    while (running.current < MAX_LEVEL_FETCHES && queue.current.length > 0) {
      running.current += 1;
      void loadLevel(queue.current.shift()!).finally(() => {
        running.current -= 1;
        pump.current();
      });
    }
  };
  /** Fetch the levels of `ids` not loaded or asked for yet; `first` puts them
   *  ahead of the queue — a folder the user opened. */
  const ensureLoaded = useCallback(
    (ids: string[], first = false) => {
      const fresh = ids.filter((id) => !requested.current.has(id) && !loaded.has(id));
      if (fresh.length === 0) return;
      for (const id of fresh) requested.current.add(id);
      queue.current = first ? [...fresh, ...queue.current] : [...queue.current, ...fresh];
      pump.current();
    },
    [loaded],
  );

  const toggleOpen = useCallback(
    (node: BrowseNode) => {
      const opening = !open.has(node.node_id);
      setOpen((prev) => withId(prev, node.node_id, opening));
      if (opening && isUnloaded(node, loaded)) ensureLoaded([node.node_id], true);
    },
    [open, loaded, ensureLoaded],
  );

  const refresh = useCallback(() => setGeneration((g) => g + 1), []);

  return { nodes, mode, found, error, open, loaded, loading, toggleOpen, ensureLoaded, refresh };
}
