import {
  makeArrayElementRows,
  type ArrayElementRow,
  type PickerFolderEntry,
  type PickerTreeNode,
  type PickerVariableEntry,
} from '@config/components/ui/datasourceTreeHelpers';
import { nodeAcceptsOrElement, nodeVarType, parseTypeToken } from '@shared/types/varType';
import { acceptedValueTypes, isStructType, primaryType } from '@shared/utils/valueTypes';
import { buildVarKey, isFolder } from '@shared/types/datasource';
import { isArrayShape, isFixedArray } from '@shared/types/arrayShape';
import { useVariableStore } from '@hmi/store/variableStore';
import type { StructSchemaNode, ComponentPropertySchema } from '@shared/types/componentProperty';
import { hasRequiredFields } from './helpers';
import { type RequiredFieldEntry } from '../bindingPickerUtils';

type TreeNode = PickerTreeNode;
type FolderEntry = PickerFolderEntry;
type VariableEntry = PickerVariableEntry;

/** Top-level datasource wrapper node for display in the picker tree */
export interface DatasourceNode {
  kind: 'datasource';
  name: string;
  type: string;
  children: PickerTreeNode[];
}

type DisplayNode = DatasourceNode | TreeNode;

function isDatasourceNode(n: DisplayNode): n is DatasourceNode {
  return n.kind === 'datasource';
}

/** Union of all row kinds rendered by the picker (var mode + component-prop mode). */
export type RowItem =
  | { kind: 'datasource'; node: DatasourceNode; depth: number }
  | { kind: 'folder'; folder: FolderEntry; depth: number }
  | { kind: 'variable'; entry: VariableEntry; depth: number }
  | ArrayElementRow<PickerVariableEntry>
  | {
      kind: 'component-prop';
      /** Composite identity key (collapse/select) — may carry an outer-group prefix. */
      key: string;
      /** Raw, unprefixed property key — used for display only. */
      propKey: string;
      schema: ComponentPropertySchema;
      depth: number;
    }
  | { kind: 'component-prop-node'; itemKey: string; node: StructSchemaNode; depth: number }
  /** Names where the rows below it come from — the counterpart of a datasource row. */
  | { kind: 'component-prop-source'; key: string; name: string; meta?: string; depth: number };

/** Current live length of a dynamic array variable's value (0 when not yet known). */
function liveArrayLength(v: PickerVariableEntry): number {
  const key = buildVarKey(v._datasource ?? '', v._path ?? v.display_name);
  const value = useVariableStore.getState().values[key];
  return Array.isArray(value) ? value.length : 0;
}

/** Flatten the var-mode tree into ordered rows, honoring collapsed-state. */
export function flattenForRender(
  nodes: DisplayNode[],
  depth: number,
  collapsed: Set<string>,
): RowItem[] {
  const rows: RowItem[] = [];
  for (const n of nodes) {
    if (isDatasourceNode(n)) {
      const key = `ds:${n.name}`;
      rows.push({ kind: 'datasource', node: n, depth });
      if (!collapsed.has(key)) rows.push(...flattenForRender(n.children, depth + 1, collapsed));
    } else if (isFolder(n)) {
      const key = folderKey(n);
      rows.push({ kind: 'folder', folder: n, depth });
      if (!collapsed.has(key)) rows.push(...flattenForRender(n.children, depth + 1, collapsed));
    } else {
      const v = n as PickerVariableEntry;
      rows.push({ kind: 'variable', entry: v, depth });
      if (isArrayShape(v) && !collapsed.has(arrayExpansionKey(v))) {
        const liveLength = isFixedArray(v) ? undefined : liveArrayLength(v);
        rows.push(...makeArrayElementRows(v, depth + 1, v._path ?? v.display_name, liveLength));
      }
    }
  }
  return rows;
}

/** Flatten the stored tree to a plain array, annotating each with _datasource and _path. */
export function flattenAll(nodes: TreeNode[], datasource: string, prefix = ''): VariableEntry[] {
  const out: VariableEntry[] = [];
  for (const n of nodes) {
    if (isFolder(n)) {
      const folderPath = prefix ? `${prefix}/${n.name}` : n.name;
      out.push(...flattenAll(n.children, datasource, folderPath));
    } else {
      const path = prefix ? `${prefix}/${n.display_name}` : n.display_name;
      out.push({ ...n, _datasource: datasource, _path: path });
    }
  }
  return out;
}

/** True if a folder is an array-of-struct: explicitly flagged, with [N]-indexed sub-folders. */
function isArrayOfStructFolder(folder: FolderEntry): boolean {
  return isArrayShape(folder) && (folder.children as TreeNode[]).length > 0;
}

/** Walk the full tree and mark array-of-struct / struct folders as selectable
 *  without removing any nodes. Used when "Show all variables" is active. */
export function annotateSelectable(
  nodes: TreeNode[],
  schemaField: {
    type?: string | string[];
    requiredFields?: RequiredFieldEntry[];
  } | null,
): TreeNode[] {
  if (!schemaField) return nodes;
  const structTarget =
    schemaField.type !== undefined && isStructType(primaryType(schemaField.type));
  return nodes.map((n): TreeNode => {
    if (!isFolder(n)) return n;
    const children = annotateSelectable(n.children, schemaField);
    let selectable = false;
    if (isArrayOfStructFolder(n)) {
      if (structTarget) selectable = true;
    } else if (structTarget) {
      if (n.children.length > 0) selectable = true;
    }
    return { ...n, selectable, children } as FolderEntry;
  });
}

/** Keep only enabled entries; apply type filter per schema field. */
export function typeFilter(
  nodes: TreeNode[],
  schemaField: {
    type?: string | string[];
    requiredFields?: RequiredFieldEntry[];
    write?: boolean;
  } | null,
  includeDisabled = false,
): TreeNode[] {
  const primary = schemaField?.type !== undefined ? primaryType(schemaField.type) : undefined;
  const structTarget = primary !== undefined && isStructType(primary);
  const isStructArrayTarget = structTarget && primary!.endsWith('[]');
  const allowed = schemaField?.type !== undefined ? acceptedValueTypes(schemaField.type) : [];

  return nodes.flatMap((n): TreeNode[] => {
    if (isFolder(n)) {
      if (isArrayOfStructFolder(n) && !isStructArrayTarget && !structTarget) {
        return [];
      }
      if (isStructArrayTarget && isArrayOfStructFolder(n)) {
        if (schemaField!.requiredFields?.length) {
          const firstElem = (n.children as TreeNode[]).find(
            (c): c is FolderEntry => isFolder(c) && /\[0\]$/.test(c.name),
          );
          if (!firstElem || !hasRequiredFields(firstElem, schemaField!.requiredFields)) {
            const filteredChildren = typeFilter(n.children, schemaField, includeDisabled);
            return filteredChildren.length ? [{ ...n, children: filteredChildren }] : [];
          }
        }
        return [{ ...n, selectable: true, children: n.children }];
      }

      if (structTarget && schemaField!.requiredFields !== undefined && !isStructArrayTarget) {
        if (schemaField!.requiredFields.length === 0) {
          if (n.children.length > 0) return [{ ...n, selectable: true, children: n.children }];
        } else if (hasRequiredFields(n, schemaField!.requiredFields)) {
          return [{ ...n, selectable: true, children: n.children }];
        }
        const filteredChildren = typeFilter(n.children, schemaField, includeDisabled);
        return filteredChildren.length ? [{ ...n, children: filteredChildren }] : [];
      }

      const filteredChildren = typeFilter(n.children, schemaField, includeDisabled);
      return filteredChildren.length ? [{ ...n, children: filteredChildren }] : [];
    }
    if (!includeDisabled && !n.enabled) return [];
    if (structTarget && schemaField!.requiredFields !== undefined) return [];
    if (n.data_type === 'struct') return [];
    if (allowed.length) {
      if (!allowed.some((t) => nodeAcceptsOrElement(parseTypeToken(t), nodeVarType(n)))) return [];
    }
    if (schemaField?.write && n.writable === false) return [];
    return [n];
  });
}

/**
 * The selection key a rendered row responds to, or null for rows that can't be
 * selected (datasource headers, non-selectable folders). Mirrors the per-kind
 * key logic in `rows.tsx` so callers can locate the row matching `selectedKey`
 * (e.g. to scroll the current binding into view on open).
 */
export function rowSelectionKey(item: RowItem): string | null {
  switch (item.kind) {
    case 'variable': {
      const v = item.entry;
      return v._datasource && v._path ? `${v._datasource}:${v._path}` : v.display_name;
    }
    case 'folder':
      return item.folder.selectable
        ? `${item.folder._datasource ?? ''}:${item.folder._path ?? item.folder.name}`
        : null;
    case 'array-element': {
      const p = item.parent;
      return `${p._datasource ?? ''}:${p._path ?? p.display_name}[${item.index}]`;
    }
    case 'component-prop':
      return item.key;
    case 'component-prop-node':
      return item.itemKey;
    default:
      return null;
  }
}

/** Unique key for a folder within the tree. */
export function folderKey(f: FolderEntry): string {
  const ds = f._datasource ?? '';
  const path = f._path ?? f.name;
  return ds ? `${ds}:${path}` : (f.node_id ?? f.name);
}

/** Find a specific folder in the raw tree by its composite key. */
export function findRawFolder(nodes: DisplayNode[], compositeKey: string): FolderEntry | null {
  for (const n of nodes) {
    if (isDatasourceNode(n)) {
      const found = findRawFolder(n.children, compositeKey);
      if (found) return found;
    } else if (isFolder(n)) {
      if (folderKey(n) === compositeKey) return n;
      const found = findRawFolder(n.children, compositeKey);
      if (found) return found;
    }
  }
  return null;
}

/** Recursively collect all folder composite keys from a freshly-loaded tree. */
export function collectFolderKeys(nodes: TreeNode[]): string[] {
  const keys: string[] = [];
  for (const n of nodes) {
    if (isFolder(n)) {
      keys.push(folderKey(n));
      keys.push(...collectFolderKeys((n as FolderEntry).children));
    }
  }
  return keys;
}

/** Collapse key for the array expansion of a variable (distinct from folder keys). */
export function arrayExpansionKey(v: PickerVariableEntry): string {
  const ds = v._datasource ?? '';
  const path = v._path ?? v.display_name;
  return `${ds}:${path}[]`;
}

/**
 * Resolve a selected composite key's raw path into the `{path, index}` shape
 * a `VariableBinding` uses (§10.5).
 *
 * Two unrelated encodings share the tree's "[N]" convention and must not be
 * conflated:
 * - A **scalar-array element** (`ArrayElementRow`) encodes its index as a
 *   bracket suffix directly on the variable's own path, no separator:
 *   `"MyArray[2]"`.
 * - A **struct[] element** is a real `[N]`-indexed sub-*folder* one level
 *   below an array-of-struct folder, joined by "/": `"Motors/[2]"` or
 *   `"Motors/Line[2]"` (static-server prefix style). The index always comes
 *   from the folder's own `name`, and the array's root path from stripping
 *   just that last path segment — never from a regex over the whole path,
 *   which would mis-parse the "/" as part of the base path.
 *
 * `rawSelectedFolder` (non-null only when the selection is a folder, from
 * `findRawFolder`) disambiguates which case applies.
 */
export function resolveElementBinding(
  datasource: string,
  rawPath: string,
  rawSelectedFolder: FolderEntry | null,
  dsTree: DatasourceNode[],
): { path: string; index?: number } {
  if (rawSelectedFolder) {
    const nameMatch = rawSelectedFolder.name.match(/\[(\d+)\]$/);
    if (!nameMatch) return { path: rawPath };
    const parentPath = rawPath.slice(0, rawPath.length - rawSelectedFolder.name.length - 1);
    const parentFolder = parentPath ? findRawFolder(dsTree, `${datasource}:${parentPath}`) : null;
    if (parentFolder && isArrayShape(parentFolder)) {
      return { path: parentPath, index: parseInt(nameMatch[1], 10) };
    }
    return { path: rawPath };
  }
  const elementMatch = rawPath.match(/^(.+)\[(\d+)\]$/);
  if (elementMatch) {
    return { path: elementMatch[1], index: parseInt(elementMatch[2], 10) };
  }
  return { path: rawPath };
}
