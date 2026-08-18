import type { FolderEntry, TreeNode, VariableEntry } from '@shared/types/datasource';
import { isFolder } from '@shared/types/datasource';
import { isArrayShape, isFixedArray } from '@shared/types/arrayShape';
import { matchesSearchWords, withDotSearchSeparators } from '@shared/utils/search';

export interface ArrayElementRow<T extends VariableEntry = VariableEntry> {
  kind: 'array-element';
  parent: T;
  index: number;
  depth: number;
  path: string; // same as the parent variable's path
}

export type RowItem =
  | { kind: 'folder'; folder: FolderEntry; depth: number; path: string }
  | { kind: 'variable'; entry: VariableEntry; depth: number; path: string }
  | ArrayElementRow;

/**
 * Produce one RowItem per element of an array variable. For a fixed-size
 * array, the count comes from `array_length`; for a dynamic-length array,
 * the caller must supply the current live length (0 when not yet known).
 */
export function makeArrayElementRows<T extends VariableEntry>(
  entry: T,
  depth: number,
  path: string,
  liveLength?: number,
): ArrayElementRow<T>[] {
  const count = isFixedArray(entry) ? (entry.array_length ?? 0) : (liveLength ?? 0);
  return Array.from({ length: count }, (_, i) => ({
    kind: 'array-element' as const,
    parent: entry,
    index: i,
    depth,
    path,
  }));
}

export interface BrowseNode {
  node_id: string;
  display_name: string;
  data_type: string | null;
  writable?: boolean;
  is_array?: boolean;
  array_length?: number;
  children?: BrowseNode[];
}

export interface PickerFolderEntry extends FolderEntry {
  selectable?: boolean;
  _path?: string;
  _datasource?: string;
  children: PickerTreeNode[];
}

export interface PickerVariableEntry extends VariableEntry {
  _path?: string;
  _datasource?: string;
}

export type PickerTreeNode = PickerFolderEntry | PickerVariableEntry;

export function parseApiTree(nodes: unknown[], datasource: string, prefix = ''): PickerTreeNode[] {
  return nodes
    .filter((n): n is Record<string, unknown> => !!n && typeof n === 'object')
    .map((n) => {
      if (n.kind === 'folder') {
        const folderPath = prefix ? `${prefix}/${String(n.name ?? '')}` : String(n.name ?? '');
        return {
          kind: 'folder',
          name: String(n.name ?? ''),
          node_id: n.node_id != null ? String(n.node_id) : undefined,
          is_array: n.is_array === true,
          children: parseApiTree(
            (n.children as unknown[] | undefined) ?? [],
            datasource,
            folderPath,
          ),
          _datasource: datasource,
          _path: folderPath,
        } satisfies PickerFolderEntry;
      }
      const displayName = String((n as Record<string, unknown>).display_name ?? '');
      const rawDataType = String((n as Record<string, unknown>).data_type ?? 'Unknown');
      const dataType = rawDataType;
      const path = prefix ? `${prefix}/${displayName}` : displayName;
      const writable =
        typeof (n as Record<string, unknown>).writable === 'boolean'
          ? ((n as Record<string, unknown>).writable as boolean)
          : undefined;
      const fieldsRaw = (n as Record<string, unknown>).fields;
      const fields =
        fieldsRaw != null && typeof fieldsRaw === 'object' && !Array.isArray(fieldsRaw)
          ? (fieldsRaw as Record<string, string>)
          : undefined;
      const is_array = (n as Record<string, unknown>).is_array === true;
      const arrayLengthRaw = (n as Record<string, unknown>).array_length;
      // array_length is meaningful only when is_array; a positive value is a
      // fixed size, absent/non-positive means dynamic (unknown) length.
      const array_length =
        is_array && typeof arrayLengthRaw === 'number' && arrayLengthRaw > 0
          ? arrayLengthRaw
          : undefined;
      return {
        kind: dataType === 'struct' ? 'struct' : 'variable',
        node_id: n.node_id != null ? String(n.node_id) : undefined,
        display_name: displayName,
        data_type: dataType,
        is_array,
        array_length,
        enabled: (n as Record<string, unknown>).enabled === true,
        writable,
        fields,
        _datasource: datasource,
        _path: path,
      } satisfies PickerVariableEntry;
    });
}

export function flattenForRender(
  nodes: TreeNode[],
  depth: number,
  collapsed: Set<string>,
  prefix = '',
): RowItem[] {
  const rows: RowItem[] = [];
  for (const node of nodes) {
    if (isFolder(node)) {
      const folderPath = prefix ? `${prefix}/${node.name}` : node.name;
      const key = folderPath;
      rows.push({ kind: 'folder', folder: node, depth, path: folderPath });
      if (!collapsed.has(key)) {
        rows.push(...flattenForRender(node.children, depth + 1, collapsed, folderPath));
      }
    } else {
      const varPath = prefix ? `${prefix}/${node.display_name}` : node.display_name;
      rows.push({ kind: 'variable', entry: node, depth, path: varPath });
      if (isArrayShape(node) && !collapsed.has(varPath)) {
        rows.push(...makeArrayElementRows(node, depth + 1, varPath));
      }
    }
  }
  return rows;
}

export function filterTree(nodes: TreeNode[], query: string, ancestorPath = ''): TreeNode[] {
  const wordQuery = withDotSearchSeparators(query);
  const out: TreeNode[] = [];
  for (const node of nodes) {
    if (isFolder(node)) {
      const folderPath = ancestorPath ? `${ancestorPath}/${node.name}` : node.name;
      if (matchesSearchWords(wordQuery, [folderPath, node.node_id])) {
        out.push(node);
      } else {
        const filtered = filterTree(node.children, wordQuery, folderPath);
        if (filtered.length > 0) out.push({ ...node, children: filtered });
      }
    } else {
      const variablePath = ancestorPath
        ? `${ancestorPath}/${node.display_name}`
        : node.display_name;
      if (matchesSearchWords(wordQuery, [variablePath, node.node_id, node.data_type]))
        out.push(node);
    }
  }
  return out;
}

export function countVars(nodes: TreeNode[]): number {
  let total = 0;
  for (const node of nodes) {
    if (isFolder(node)) total += countVars(node.children);
    else total += 1;
  }
  return total;
}

export function countEnabledVars(nodes: TreeNode[]): number {
  let total = 0;
  for (const node of nodes) {
    if (isFolder(node)) total += countEnabledVars(node.children);
    else if (node.enabled) total += 1;
  }
  return total;
}

export function setEnabledInSubtree(nodes: TreeNode[], enabled: boolean): TreeNode[] {
  return nodes.map((node) => {
    if (isFolder(node)) return { ...node, children: setEnabledInSubtree(node.children, enabled) };
    return { ...node, enabled };
  });
}

export function collectFolderKeys(nodes: TreeNode[], prefix = ''): string[] {
  const keys: string[] = [];
  for (const node of nodes) {
    if (isFolder(node)) {
      const folderPath = prefix ? `${prefix}/${node.name}` : node.name;
      keys.push(folderPath);
      keys.push(...collectFolderKeys(node.children, folderPath));
    }
  }
  return keys;
}

/**
 * Update the variable at `path`. Array-of-struct elements share identical
 * field names across elements (e.g. every element has a field "Field1"), so
 * matching by `path` (not `display_name`) is required to scope the patch to
 * exactly one element instead of every same-named sibling (§3.3). `node_id`
 * is preferred when present since it's the globally unique OPC-UA identifier.
 */
export function updateVarInTree(
  tree: TreeNode[],
  path: string,
  nodeId: string | undefined,
  patch: Partial<VariableEntry>,
): TreeNode[] {
  const walk = (nodes: TreeNode[], prefix: string): TreeNode[] =>
    nodes.map((node) => {
      if (isFolder(node)) {
        const folderPath = prefix ? `${prefix}/${node.name}` : node.name;
        return { ...node, children: walk(node.children, folderPath) };
      }
      const varPath = prefix ? `${prefix}/${node.display_name}` : node.display_name;
      const match = nodeId ? node.node_id === nodeId : varPath === path;
      return match ? { ...node, ...patch } : node;
    });
  return walk(tree, '');
}

/** True when every child is itself a folder named with a trailing `[N]` index —
 *  the array-of-struct convention used by both static/test-server authoring
 *  and PLC naming (e.g. Beckhoff `[0]`, `[1]` sub-objects). */
function looksLikeArrayOfStruct(children: TreeNode[]): boolean {
  return children.length > 0 && children.every((c) => isFolder(c) && /\[\d+\]$/.test(c.name));
}

export function buildFromBrowse(
  browseNodes: BrowseNode[],
  enabledMap: Map<string, boolean>,
  visitedIds: Set<string> = new Set(),
): TreeNode[] {
  const result: TreeNode[] = [];
  for (const child of browseNodes) {
    if (visitedIds.has(child.node_id)) continue;
    visitedIds.add(child.node_id);

    if (child.data_type !== null && child.data_type !== undefined) {
      const entry: VariableEntry = {
        kind: 'variable',
        node_id: child.node_id,
        display_name: child.display_name,
        data_type: child.data_type ?? 'Unknown',
        enabled: enabledMap.get(child.node_id) ?? false,
        writable: child.writable ?? false,
      };
      if (child.is_array) {
        entry.is_array = true;
        if (isFixedArray(child)) {
          entry.array_length = child.array_length;
        }
      }
      result.push(entry);
    } else {
      const builtChildren = buildFromBrowse(child.children ?? [], enabledMap, visitedIds);
      const folder: FolderEntry = {
        kind: 'folder',
        name: child.display_name,
        node_id: child.node_id,
        children: builtChildren,
      };
      if (looksLikeArrayOfStruct(builtChildren)) {
        folder.is_array = true;
      }
      result.push(folder);
    }
  }
  return result;
}
