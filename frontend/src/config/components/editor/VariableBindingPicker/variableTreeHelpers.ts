import {
  makeArrayElementRows,
  type ArrayElementRow,
  type PickerFolderEntry,
  type PickerTreeNode,
  type PickerVariableEntry,
} from '@config/components/ui/datasourceTreeHelpers';
import { nodeAcceptsOrElement, nodeVarType, parseTypeToken } from '@shared/types/varType';
import { acceptedValueTypes, isStructType } from '@shared/utils/valueTypes';
import { buildVarKey, isFolder } from '@shared/types/datasource';
import { isArrayShape, isFixedArray } from '@shared/types/arrayShape';
import { useVariableStore } from '@hmi/store/variableStore';
import type { StructSchemaNode, ComponentPropertySchema } from '@shared/types/componentProperty';
import { hasRequiredFields, shapeElementFolder } from './helpers';
import { type RequiredFieldEntry } from '../bindingPickerUtils';
import { REPEAT_INDEX_SUFFIX } from './repeatItemRows';

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
  /** `[#]` under an array: the element at the Repeater copy's own index. */
  | { kind: 'repeat-element'; parent: PickerVariableEntry; depth: number }
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

/** Flatten the var-mode tree into ordered rows, honoring collapsed-state.
 *  `repeatElement` adds a `[#]` row to every array, for a field inside a Repeater;
 *  `bits` a Bit row per bit under each whole number the user expands. */
export function flattenForRender(
  nodes: DisplayNode[],
  depth: number,
  collapsed: Set<string>,
  repeatElement = false,
  bits = false,
): RowItem[] {
  const rows: RowItem[] = [];
  const children = (level: DisplayNode[]) =>
    flattenForRender(level, depth + 1, collapsed, repeatElement, bits);
  for (const n of nodes) {
    if (isDatasourceNode(n)) {
      const key = `ds:${n.name}`;
      rows.push({ kind: 'datasource', node: n, depth });
      if (!collapsed.has(key)) rows.push(...children(n.children));
    } else if (isFolder(n)) {
      const key = folderKey(n);
      rows.push({ kind: 'folder', folder: n, depth });
      if (!collapsed.has(key)) rows.push(...children(n.children));
    } else {
      const v = n as PickerVariableEntry;
      rows.push({ kind: 'variable', entry: v, depth });
      if (isArrayShape(v) && !collapsed.has(arrayExpansionKey(v))) {
        const liveLength = isFixedArray(v) ? undefined : liveArrayLength(v);
        if (repeatElement) rows.push({ kind: 'repeat-element', parent: v, depth: depth + 1 });
        rows.push(...makeArrayElementRows(v, depth + 1, v._path ?? v.display_name, liveLength));
      }
      // Unlike an array, a word starts closed: its bits open on request.
      if (bits && hasBits(v) && collapsed.has(bitsExpansionKey(v))) {
        for (const entry of bitEntries(v)) {
          rows.push({ kind: 'variable', entry, depth: depth + 1 });
        }
      }
    }
  }
  return rows;
}

/** Separates a variable's path from a bit number in a picker key
 *  (`Battery/Status.%X3`). Never shown: the bit reads `Status.3`. */
export const BIT_KEY = '.%X';
const BIT_KEY_RE = /^(.+)\.%X(\d+)$/;

/** Whether the picker lists the bits of a variable: a whole number, not an
 *  array. The tree's simple types hide the width, so it rides along as `bits`. */
export function hasBits(v: PickerVariableEntry): boolean {
  return !isArrayShape(v) && (v.bits ?? 0) > 0;
}

/** Toggle-set key of a word's bit list. Present means open — the reverse of
 *  every other key there, since a word starts closed. */
export function bitsExpansionKey(v: PickerVariableEntry): string {
  return `${v._datasource ?? ''}:${v._path ?? v.display_name}${BIT_KEY}`;
}

/** One Boolean entry per bit of `v`, keyed `<path>.%X<n>` and named `Bit <n>`. */
export function bitEntries(v: PickerVariableEntry): PickerVariableEntry[] {
  const path = v._path ?? v.display_name;
  return Array.from({ length: v.bits ?? 0 }, (_, n) => ({
    ...v,
    bits: undefined,
    node_id: undefined,
    display_name: `Bit ${n}`,
    data_type: 'Boolean',
    _path: `${path}${BIT_KEY}${n}`,
  }));
}

/** A picker key's path split into its variable and bit, or null for no bit. */
export function splitBitKey(rawPath: string): { path: string; bit: number } | null {
  const m = rawPath.match(BIT_KEY_RE);
  return m ? { path: m[1], bit: Number(m[2]) } : null;
}

/** A bit key as the user reads it: `Status.%X3` → `Status.3`. */
export const bitKeyLabel = (text: string): string => text.replace(BIT_KEY_RE, '$1.$2');

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

/**
 * Which struct shapes a field takes, read from *every* type it accepts rather
 * than the first: a Repeater's items lead with the `item-list` editor kind and
 * still take a `struct[]`.
 */
function structShapes(allowed: string[]) {
  const structs = allowed.filter(isStructType);
  return {
    single: structs.some((t) => !t.endsWith('[]')),
    array: structs.some((t) => t.endsWith('[]')),
    /** Nothing but structs — a plain variable can never fit. */
    only: structs.length > 0 && structs.length === allowed.length,
  };
}

/** Walk the full tree and mark array-of-struct / struct folders as selectable,
 *  dropping only disabled variables. Used when "Show all variables" is active. */
export function annotateSelectable(
  nodes: TreeNode[],
  schemaField: {
    type?: string | string[];
    requiredFields?: RequiredFieldEntry[];
  } | null,
): TreeNode[] {
  const shapes = structShapes(
    schemaField?.type !== undefined ? acceptedValueTypes(schemaField.type) : [],
  );
  // "Show all" lets any struct folder be picked for any struct field; the
  // drawer's ✓/✗ then says whether it fits.
  const takesStruct = shapes.single || shapes.array;
  const annotate = (level: TreeNode[]): TreeNode[] =>
    level.flatMap((n): TreeNode[] => {
      if (!isFolder(n)) return n.enabled ? [n] : [];
      const children = annotate(n.children);
      const selectable = takesStruct && (isArrayOfStructFolder(n) || children.length > 0);
      return [{ ...n, selectable, children } as FolderEntry];
    });
  return annotate(nodes);
}

/** Keep only enabled entries; apply type filter per schema field. With `bits`,
 *  a whole number stays wherever its bits — Booleans — fit. */
export function typeFilter(
  nodes: TreeNode[],
  schemaField: {
    type?: string | string[];
    requiredFields?: RequiredFieldEntry[];
    write?: boolean;
  } | null,
  bits = false,
): TreeNode[] {
  const allowed = schemaField?.type !== undefined ? acceptedValueTypes(schemaField.type) : [];
  const bitsFit = bits && allowed.some((t) => t.toLowerCase() === 'boolean');
  const shapes = structShapes(allowed);
  const required = schemaField?.requiredFields;

  const filterLevel = (level: TreeNode[]): TreeNode[] =>
    level.flatMap((n): TreeNode[] => {
      if (isFolder(n)) {
        const recurse = (): TreeNode[] => {
          const filteredChildren = filterLevel(n.children);
          return filteredChildren.length ? [{ ...n, children: filteredChildren }] : [];
        };
        if (isArrayOfStructFolder(n)) {
          if (!shapes.array && !shapes.single) return [];
          if (!shapes.array) return recurse();
          if (required?.length) {
            const element = shapeElementFolder(n);
            if (!element || !hasRequiredFields(element, required)) return recurse();
          }
          return [{ ...n, selectable: true, children: n.children }];
        }
        if (shapes.single) {
          const fits = required?.length ? hasRequiredFields(n, required) : n.children.length > 0;
          if (fits) return [{ ...n, selectable: true, children: n.children }];
        }
        return recurse();
      }
      if (!n.enabled) return [];
      if (shapes.only) return [];
      if (n.data_type === 'struct') return [];
      if (allowed.length && !(bitsFit && hasBits(n))) {
        if (!allowed.some((t) => nodeAcceptsOrElement(parseTypeToken(t), nodeVarType(n))))
          return [];
      }
      // Unset access is read-only, as the drawer's verdict and the backend read it.
      if (schemaField?.write && n.writable !== true) return [];
      return [n];
    });
  return filterLevel(nodes);
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
    case 'array-element':
    case 'repeat-element': {
      const p = item.parent;
      const suffix = item.kind === 'array-element' ? `[${item.index}]` : REPEAT_INDEX_SUFFIX;
      return `${p._datasource ?? ''}:${p._path ?? p.display_name}${suffix}`;
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
 * a `VariableBinding` uses.
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
