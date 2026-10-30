/**
 * The variable table with the PLC in it (ADS "Show PLC variables"): the saved
 * tree's rows, plus a dimmed `plc` row for each browse node the datasource
 * does not have yet, under the saved folder its PLC path names. Ticking one
 * adds it (`mergeBrowseSelection`); nothing here changes the saved tree.
 */

import { isFolder, type TreeNode } from '@shared/types/datasource';
import { matchesSearchWords, withDotSearchSeparators } from '@shared/utils/search';
import {
  flattenForRender,
  type BrowseNode,
  type RowItem,
} from '@config/components/ui/datasourceTreeHelpers';
import { isBrowseLeaf, newLeafIds, nodeKey } from './browseMerge';

export interface PlcRow {
  kind: 'plc';
  node: BrowseNode;
  depth: number;
  path: string;
  /** A variable, not a folder or struct. */
  leaf: boolean;
  /** What ticking the row adds: the leaf itself, or a folder's new leaves loaded so far. */
  newIds: string[];
  /** A folder showing its children. */
  open: boolean;
  /** A lazy folder whose level has not been fetched yet. */
  unloaded: boolean;
  loading: boolean;
}

type FolderRow = Extract<RowItem, { kind: 'folder' }>;

/** A table row: a saved one (a collapsed saved folder counting the new PLC
 *  variables inside it, loaded so far), or a PLC one. */
export type TableRow = Exclude<RowItem, FolderRow> | (FolderRow & { plcNew?: number }) | PlcRow;

/** What a check against the PLC says of the saved variables, by `nodeKey`. */
export interface PlcMarks {
  missing: ReadonlySet<string>;
  /** Saved with another data type than the PLC's, which is the value. */
  changed: ReadonlyMap<string, string>;
  /** The check failed: no marks, and why. */
  error: string | null;
}

export interface PlcOverlay {
  nodes: BrowseNode[];
  /** Saved variables' node ids, as `nodeKey`s. */
  saved: ReadonlySet<string>;
  /** Open PLC folders by node id; null opens them all (while filtering). */
  open: ReadonlySet<string> | null;
  loaded: ReadonlySet<string>;
  loading: ReadonlySet<string>;
}

export function isUnloaded(node: BrowseNode, loaded: ReadonlySet<string>): boolean {
  return !!node.has_children && !node.children?.length && !loaded.has(node.node_id);
}

function hasUnloaded(nodes: BrowseNode[], loaded: ReadonlySet<string>): boolean {
  return nodes.some(
    (n) => !isBrowseLeaf(n) && (isUnloaded(n, loaded) || hasUnloaded(n.children ?? [], loaded)),
  );
}

function plcRows(nodes: BrowseNode[], plc: PlcOverlay, depth: number, prefix: string): PlcRow[] {
  const rows: PlcRow[] = [];
  for (const node of nodes) {
    const path = prefix ? `${prefix}/${node.display_name}` : node.display_name;
    if (isBrowseLeaf(node)) {
      if (!plc.saved.has(nodeKey(node.node_id))) {
        rows.push({
          kind: 'plc',
          node,
          depth,
          path,
          leaf: true,
          newIds: [node.node_id],
          open: false,
          unloaded: false,
          loading: false,
        });
      }
      continue;
    }
    const unloaded = isUnloaded(node, plc.loaded);
    const newIds = newLeafIds(node.children ?? [], plc.saved);
    // A folder with nothing new below it (all saved, or empty) is noise —
    // unless part of it is not loaded yet.
    if (!unloaded && newIds.length === 0 && !hasUnloaded(node.children ?? [], plc.loaded)) continue;
    const open = plc.open === null || plc.open.has(node.node_id);
    rows.push({
      kind: 'plc',
      node,
      depth,
      path,
      leaf: false,
      newIds,
      open,
      unloaded,
      loading: plc.loading.has(node.node_id),
    });
    if (open) rows.push(...plcRows(node.children ?? [], plc, depth + 1, path));
  }
  return rows;
}

/**
 * `flattenForRender` with the PLC's new nodes woven in. A saved folder is
 * matched to its PLC twin by node id; the twin's nodes the datasource does not
 * have follow the folder's own rows. `wanted` collects the lazy twins of open
 * saved folders whose level is not loaded yet, for the caller to fetch.
 */
export function flattenWithPlc(
  tree: TreeNode[],
  collapsed: Set<string>,
  plc: PlcOverlay | null,
  wanted: string[] = [],
  depth = 0,
  prefix = '',
): TableRow[] {
  const rows: TableRow[] = [];
  const matched = new Set<string>();
  for (const node of tree) {
    if (!isFolder(node)) {
      rows.push(...flattenForRender([node], depth, collapsed, prefix));
      continue;
    }
    const path = prefix ? `${prefix}/${node.name}` : node.name;
    const twin =
      plc && node.node_id
        ? plc.nodes.find((n) => nodeKey(n.node_id) === nodeKey(node.node_id!))
        : undefined;
    if (twin) matched.add(nodeKey(twin.node_id));
    if (collapsed.has(path)) {
      const plcNew = plc && twin ? newLeafIds(twin.children ?? [], plc.saved).length : 0;
      rows.push({ kind: 'folder', folder: node, depth, path, ...(plcNew > 0 && { plcNew }) });
      continue;
    }
    rows.push({ kind: 'folder', folder: node, depth, path });
    if (plc && twin && isUnloaded(twin, plc.loaded)) wanted.push(twin.node_id);
    const inner = plc && twin ? { ...plc, nodes: twin.children ?? [] } : null;
    rows.push(...flattenWithPlc(node.children, collapsed, inner, wanted, depth + 1, path));
  }
  if (plc) {
    const unmatched = plc.nodes.filter((n) => !matched.has(nodeKey(n.node_id)));
    rows.push(...plcRows(unmatched, plc, depth, prefix));
  }
  return rows;
}

/** The browse nodes matching `query`, with their folders — as `filterTree`. */
export function filterBrowse(nodes: BrowseNode[], query: string, prefix = ''): BrowseNode[] {
  const wordQuery = withDotSearchSeparators(query);
  const out: BrowseNode[] = [];
  for (const node of nodes) {
    const path = prefix ? `${prefix}/${node.display_name}` : node.display_name;
    if (isBrowseLeaf(node)) {
      if (matchesSearchWords(wordQuery, [path, node.node_id, node.data_type])) out.push(node);
    } else if (matchesSearchWords(wordQuery, [path, node.node_id])) {
      out.push(node);
    } else {
      const children = filterBrowse(node.children ?? [], wordQuery, path);
      if (children.length > 0) out.push({ ...node, children });
    }
  }
  return out;
}
