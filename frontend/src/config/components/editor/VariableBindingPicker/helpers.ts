/**
 * Helpers shared between the main VariableBindingPicker module and its
 * RightPanel subcomponent — the drawer's verdicts among them, which Confirm
 * follows as well as the ✓/✗.
 */

import type {
  PickerFolderEntry,
  PickerVariableEntry,
  PickerTreeNode,
} from '@config/components/ui/datasourceTreeHelpers';
import { isFolder } from '@shared/types/datasource';
import { isArrayShape } from '@shared/types/arrayShape';
import { typeLabel } from '@shared/types/componentProperty';
import type { StructSchemaNode } from '@shared/types/componentProperty';
import {
  nodeVarType,
  parseTypeToken,
  structSatisfies,
  type StructMember,
  type StructMemberLookup,
  type VarType,
} from '@shared/types/varType';
import { baseType, isEditorKind, primaryType } from '@shared/utils/valueTypes';
import { type RequiredFieldEntry } from '../bindingPickerUtils';
import type { VarMode } from './RightPanel';

/** A type as the drawer shows it: simple types in their canonical spelling
 *  (`float` → `Float`, `string[]` → `String[]`), whatever case they were
 *  authored in, so every row and the Required panel read alike. */
export function formatTypeBadge(type: string | string[]): string {
  return (Array.isArray(type) ? type : [type]).map(typeLabel).join(', ');
}

/** A variable as a struct member — or none when it is disabled or gone from
 *  the server: the pool serves no such variable, so the runtime and the backend
 *  find no member there either. A type the tree does not state (a Repeat item
 *  member only the runtime knows) is left unknown, and taken on trust. */
export function variableMember(v: PickerVariableEntry): StructMember | undefined {
  if (v.enabled === false || v.present_on_server === false) return undefined;
  return { type: v.data_type ? nodeVarType(v) : undefined, writable: v.writable };
}

/** A sub-folder as a struct member: a struct array when the tree flags it one. */
function folderMember(folder: PickerFolderEntry): StructMember {
  return { type: { kind: 'struct', name: folder.name, fields: [], array: isArrayShape(folder) } };
}

/** Members by name — a struct's variables and its sub-struct folders — as the
 *  lookup `structSatisfies` walks, descending into the folders for nested paths. */
export function memberLookup(
  variables: Record<string, PickerVariableEntry>,
  folders: Record<string, PickerFolderEntry>,
): StructMemberLookup {
  return (path) => {
    const slash = path.indexOf('/');
    if (slash === -1) {
      const v = variables[path];
      if (v) return variableMember(v);
      return folders[path] ? folderMember(folders[path]) : undefined;
    }
    const folder = folders[path.slice(0, slash)];
    return folder ? folderMemberLookup(folder)(path.slice(slash + 1)) : undefined;
  };
}

/** The members a folder's children offer as a struct. */
export function folderMemberLookup(folder: PickerFolderEntry): StructMemberLookup {
  const variables: Record<string, PickerVariableEntry> = {};
  const folders: Record<string, PickerFolderEntry> = {};
  for (const c of folder.children as PickerTreeNode[]) {
    if (isFolder(c)) folders[c.name] = c;
    else variables[c.display_name] = c;
  }
  return memberLookup(variables, folders);
}

const ELEMENT_NAME = /\[(\d+)\]$/;

/** The element folder a struct array's shape is read off: the lowest-index
 *  one, since an array may count from 1 — the element the runtime and the
 *  backend validator judge an unindexed binding on. */
export function shapeElementFolder(folder: PickerFolderEntry): PickerFolderEntry | undefined {
  let lowest: { index: number; folder: PickerFolderEntry } | undefined;
  for (const c of folder.children as PickerTreeNode[]) {
    const match = isFolder(c) ? ELEMENT_NAME.exec(c.name) : null;
    if (match && isFolder(c) && (!lowest || Number(match[1]) < lowest.index)) {
      lowest = { index: Number(match[1]), folder: c };
    }
  }
  return lowest?.folder;
}

/**
 * Whether a folder, taken as a struct, offers every required field with the
 * type and access it asks for — the same `structSatisfies` rule the runtime
 * and the backend validator apply, so the tree's filter, the drawer's ✓/✗ and
 * the warnings pill agree.
 */
export function hasRequiredFields(
  folder: PickerFolderEntry,
  requiredFields: RequiredFieldEntry[],
): boolean {
  return structSatisfies(requiredFields, folderMemberLookup(folder));
}

/**
 * The type a value declared as `token` holds — a component property, an
 * exported property or a struct-schema field. An editor kind's value is its
 * own payload (an icon `{ type, name }`, an image `{ path }`), so it has no
 * type here: only a slot of that same kind takes it. `fields` names a
 * struct's members.
 */
export function declaredVarType(token: string, fields: string[] = []): VarType | undefined {
  if (isEditorKind(token)) return undefined;
  const accept = parseTypeToken(token);
  return accept.kind === 'scalar' && accept.base
    ? { kind: 'scalar', base: accept.base, array: accept.array }
    : { kind: 'struct', name: baseType(token), fields, array: accept.array };
}

/** A struct-schema node's type: a folder is a struct, an array node an array
 *  of its `type` (of a struct, when it holds fields), a variable its `type`. */
export function structSchemaNodeVarType(node: StructSchemaNode): VarType | undefined {
  const fields = (node.children ?? []).map((c) => c.name);
  if (node.kind === 'folder') return { kind: 'struct', name: node.name, fields, array: false };
  if (node.kind === 'array') {
    if (fields.length) return { kind: 'struct', name: node.name, fields, array: true };
    const element = node.type ? declaredVarType(node.type) : undefined;
    return element && { ...element, array: true };
  }
  return node.type ? declaredVarType(node.type) : undefined;
}

/** A struct-schema tree's members by slash path, as the lookup `structSatisfies`
 *  walks. Only a `variable` node is writable, and only when it says so. */
export function structSchemaLookup(nodes: StructSchemaNode[]): StructMemberLookup {
  return (path) => {
    const slash = path.indexOf('/');
    const name = slash === -1 ? path : path.slice(0, slash);
    const node = nodes.find((n) => n.name === name);
    if (!node) return undefined;
    if (slash !== -1) return structSchemaLookup(node.children ?? [])(path.slice(slash + 1));
    return {
      type: structSchemaNodeVarType(node),
      writable: node.kind === 'variable' && node.write === true,
    };
  };
}

/** For an array-of-struct folder, return the children of the element its
 *  shape is read off, so that the requirement display shows fields rather than
 *  the element sub-folders. */
export function firstElementChildren(folder: PickerFolderEntry): PickerTreeNode[] {
  return shapeElementFolder(folder)?.children ?? folder.children;
}

export function childMaps(folder: PickerFolderEntry): {
  childMap: Record<string, PickerVariableEntry>;
  childFolders: Record<string, PickerFolderEntry>;
} {
  return {
    childMap: Object.fromEntries(
      folder.children
        .filter((c): c is PickerVariableEntry => !isFolder(c))
        .map((c) => [c.display_name, c]),
    ),
    childFolders: Object.fromEntries(
      folder.children.filter((c): c is PickerFolderEntry => isFolder(c)).map((c) => [c.name, c]),
    ),
  };
}

/** Whether the selection supplies one required field — the ✓/✗ beside it. */
export function requiredFieldMatched(
  f: RequiredFieldEntry,
  childMap: Record<string, PickerVariableEntry>,
  childFolders: Record<string, PickerFolderEntry> | undefined,
): boolean {
  return structSatisfies([f], memberLookup(childMap, childFolders ?? {}));
}

/** What a var-mode selection offers as the struct's fields: a folder's children
 *  (an element's, for a struct-array field), a Repeat item's members, or
 *  nothing at all — a scalar picked for a struct field misses every field.
 *  `undefined` while there is nothing to judge yet. */
export function structOffer(
  mode: VarMode,
  hasSelection: boolean,
):
  | {
      childMap: Record<string, PickerVariableEntry>;
      childFolders: Record<string, PickerFolderEntry>;
    }
  | undefined {
  const { schemaField, rawSelectedFolder, repeatSelected, pendingSelection } = mode;
  if (!hasSelection || pendingSelection) return undefined;
  if (repeatSelected) {
    return { childMap: repeatSelected.fields, childFolders: repeatSelected.folders ?? {} };
  }
  if (!rawSelectedFolder) return { childMap: {}, childFolders: {} };
  const structArrayTarget =
    schemaField?.type !== undefined && primaryType(schemaField.type).endsWith('[]');
  return childMaps(
    structArrayTarget
      ? { ...rawSelectedFolder, children: firstElementChildren(rawSelectedFolder) }
      : rawSelectedFolder,
  );
}

/** The ✓/✗ for a struct field's selection — `null` while nothing is judged. */
export function varStructVerdict(mode: VarMode, hasSelection: boolean): boolean | null {
  const requiredFields = mode.schemaField?.requiredFields;
  const offered = structOffer(mode, hasSelection);
  if (!requiredFields || offered === undefined) return null;
  const { repeatSelected, rawSelectedFolder } = mode;
  const shapeOk = repeatSelected
    ? Object.keys(repeatSelected.fields).length + Object.keys(repeatSelected.folders ?? {}).length >
      0
    : rawSelectedFolder !== null && mode.strictFolderSelectable;
  return (
    shapeOk &&
    requiredFields.every((f) => requiredFieldMatched(f, offered.childMap, offered.childFolders))
  );
}
