import {
  componentPropertyToSchemaField,
  type ComponentPropertySchema,
  type StructSchemaNode,
} from '@shared/types/componentProperty';
import { accepts, parseTypeToken, structSatisfies, type VarType } from '@shared/types/varType';
import { type RequiredFieldEntry } from '../bindingPickerUtils';
import { declaredVarType, structSchemaLookup, structSchemaNodeVarType } from './helpers';
import type { RowItem } from './variableTreeHelpers';
import {
  acceptedValueTypes,
  isEditorKind,
  isStructType,
  primaryType,
  typeList,
} from '@shared/utils/valueTypes';
import { matchesSearchWords } from '@shared/utils/search';

/** Split a component-property key into its muted breadcrumb (`''` for a
 *  top-level property) and the leaf label. */
export function splitComponentPropPath(
  value: string,
  properties: Record<string, ComponentPropertySchema>,
): { parentPath: string; leaf: string } {
  const slashIdx = value.indexOf('/');
  if (slashIdx === -1) return { parentPath: '', leaf: properties[value]?.label ?? value };
  const propKey = value.slice(0, slashIdx);
  const segments = value.slice(slashIdx + 1).split('/');
  const prefix = properties[propKey]?.label ?? propKey;
  return {
    parentPath: [prefix, ...segments.slice(0, -1)].join(' › '),
    leaf: segments[segments.length - 1],
  };
}

/** True when a field's merged type expects a struct binding. */
export function isStructTarget(fieldType: string | string[]): boolean {
  return isStructType(primaryType(fieldType));
}

/** The field a component property, an exported property or one of their
 *  struct fields is bound to. No `fieldType` takes any type. */
export interface PropSlot {
  fieldType?: string | string[];
  requiredFields?: RequiredFieldEntry[];
  /** The field writes its value back. */
  write?: boolean;
}

/** Whether a property fits a field, and why not when the reason is not the
 *  type the drawer already shows beside it. */
export interface PropVerdict {
  ok: boolean;
  reason?: string;
}

/** A writing field refuses a property that does not say it can be written. */
const NOT_WRITABLE: PropVerdict = { ok: false, reason: 'Not declared writable' };

/**
 * Whether a value declared as `token` (typed `type`, members `members`) is of
 * a type the slot takes — through `accepts` over the slot's
 * `acceptedValueTypes`, the rule the variable tree uses, so a component
 * property and a variable of the same type fit the same fields. An editor-kind
 * value fits only a slot of that kind; an untyped value is taken on trust,
 * except by a slot that takes structs alone. Access is judged apart, so a
 * property of the right type is listed and marked rather than hidden.
 */
function declaredFits(
  token: string | undefined,
  type: VarType | undefined,
  members: StructSchemaNode[] | undefined,
  slot: PropSlot,
): boolean {
  if (slot.fieldType === undefined && !slot.requiredFields?.length) return true;
  const fieldType = slot.fieldType ?? [];
  const kinds = typeList(fieldType).filter(isEditorKind);
  if (token !== undefined && isEditorKind(token)) {
    return kinds.some((k) => k.toLowerCase() === token.toLowerCase());
  }
  const allowed = acceptedValueTypes(fieldType);
  if (allowed.length === 0 && kinds.length > 0) return false;
  if (!type) return allowed.length === 0 || !allowed.every(isStructType);
  if (
    allowed.length > 0 &&
    !allowed.some((t) => accepts(parseTypeToken(t), type, slot.requiredFields))
  ) {
    return false;
  }
  return (
    type.kind !== 'struct' ||
    !slot.requiredFields?.length ||
    structSatisfies(slot.requiredFields, structSchemaLookup(members ?? []))
  );
}

/** Whether a component property is of a type the field takes — its
 *  schema-field form, so a `select` is judged by the type its options hold.
 *  What the list shows without **Show all**. */
export function componentPropFits(prop: ComponentPropertySchema, slot: PropSlot): boolean {
  const token = primaryType(componentPropertyToSchemaField(prop).type);
  const fields = (prop.structSchema ?? []).map((n) => n.name);
  return declaredFits(token, declaredVarType(token, fields), prop.structSchema, slot);
}

/** Whether one field of a struct property is of a type the field takes. */
export function structSchemaNodeFits(node: StructSchemaNode, slot: PropSlot): boolean {
  return declaredFits(
    node.kind === 'variable' ? node.type : undefined,
    structSchemaNodeVarType(node),
    node.children,
    slot,
  );
}

/** The drawer's verdict on a component property: its type, and — for a
 *  writing field — its own `write` flag. */
export function componentPropVerdict(prop: ComponentPropertySchema, slot: PropSlot): PropVerdict {
  if (!componentPropFits(prop, slot)) return { ok: false };
  return slot.write && prop.write !== true ? NOT_WRITABLE : { ok: true };
}

/** The drawer's verdict on one field of a struct property: only a variable
 *  row that says `write: true` can be written. */
export function structSchemaNodeVerdict(node: StructSchemaNode, slot: PropSlot): PropVerdict {
  if (!structSchemaNodeFits(node, slot)) return { ok: false };
  return slot.write && !(node.kind === 'variable' && node.write === true)
    ? NOT_WRITABLE
    : { ok: true };
}

/** The slot a picker judges by, or none when the field constrains nothing. */
export function propSlotOf(
  fieldType: string | string[] | undefined,
  requiredFields: RequiredFieldEntry[] | undefined,
  write: boolean | undefined,
): PropSlot | null {
  return fieldType !== undefined || requiredFields?.length || write
    ? { fieldType, requiredFields, write }
    : null;
}

function hasCompatibleDescendant(nodes: StructSchemaNode[], slot: PropSlot): boolean {
  return nodes.some(
    (node) =>
      structSchemaNodeFits(node, slot) ||
      (!!node.children?.length && hasCompatibleDescendant(node.children, slot)),
  );
}

function nodePathMatches(nodes: StructSchemaNode[], query: string, ancestorPath: string): boolean {
  return nodes.some((node) => {
    const nodePath = `${ancestorPath} / ${node.name}`;
    return (
      matchesSearchWords(query, [nodePath, node.type, node.kind]) ||
      (!!node.children?.length && nodePathMatches(node.children, query, nodePath))
    );
  });
}

interface BuildComponentPropRowsOptions {
  /** Prepended to each row's composite identity key (collapse/select), so
   *  callers that nest this tree under an outer grouping (e.g. WidgetPropPicker's
   *  per-component property list) can keep keys unique across groups. Never
   *  shown — display always uses the raw, unprefixed key. */
  keyPrefix?: string;
  /** Depth of the top-level property rows; child rows nest below it. */
  baseDepth?: number;
  /** Searchable parent path, such as the owning widget label/id. */
  searchPath?: string;
  /** The bound field writes its value back. */
  write?: boolean;
}

/**
 * Build RowItem[] for a component-prop tree (top-level properties, each
 * optionally expanding into a nested StructSchemaNode tree).
 *
 * Search semantics: a row is *shown* if its own label/key matches, or any
 * descendant node name matches — but once shown, its full subtree renders
 * (subject to collapse state), not just the matching descendants. This
 * "gate, don't prune" behavior was chosen (over pruning to only the matching
 * fields) because it keeps a matched struct's shape legible — seeing only
 * the fields that happened to match the query, with siblings silently
 * removed, made it hard to tell the field apart from its surrounding struct.
 */
export function buildComponentPropRows(
  properties: Record<string, ComponentPropertySchema>,
  fieldType: string | string[] | undefined,
  requiredFields: RequiredFieldEntry[] | undefined,
  search: string,
  showAll: boolean,
  collapsed: Set<string>,
  options?: BuildComponentPropRowsOptions,
): RowItem[] {
  const keyPrefix = options?.keyPrefix ?? '';
  const baseDepth = options?.baseDepth ?? 0;
  const searchPath = options?.searchPath ?? '';
  const rows: RowItem[] = [];
  for (const [propKey, schema] of Object.entries(properties)) {
    // A widgets property names a slot; it holds no value, so `$componentProp`
    // pointed at it resolves to nothing forever — not even under "show all".
    if (primaryType(schema.type).toLowerCase() === 'widgets') continue;
    if (!showAll && fieldType !== undefined) {
      const slot = { fieldType, requiredFields, write: options?.write };
      const directlyOk = componentPropFits(schema, slot);
      if (!directlyOk) {
        const hasDesc =
          isStructType(primaryType(schema.type)) &&
          !!schema.structSchema?.length &&
          hasCompatibleDescendant(schema.structSchema, slot);
        if (!hasDesc) continue;
      }
    }
    if (search.trim()) {
      const propertyPath = searchPath
        ? `${searchPath} / ${schema.label} ${propKey}`
        : `${schema.label} ${propKey}`;
      const topMatch = matchesSearchWords(search, [propertyPath, ...typeList(schema.type)]);
      const nodeMatch =
        isStructType(primaryType(schema.type)) &&
        !!schema.structSchema?.length &&
        nodePathMatches(schema.structSchema, search, propertyPath);
      if (!topMatch && !nodeMatch) continue;
    }
    const key = `${keyPrefix}${propKey}`;
    rows.push({ kind: 'component-prop', key, propKey, schema, depth: baseDepth });
    const isStructWithChildren =
      isStructType(primaryType(schema.type)) && !!schema.structSchema?.length;
    if (isStructWithChildren && !collapsed.has(key) && schema.structSchema) {
      appendComponentPropNodeRows(rows, key, schema.structSchema, baseDepth + 1, collapsed);
    }
  }
  return rows;
}

function appendComponentPropNodeRows(
  rows: RowItem[],
  parentKey: string,
  nodes: StructSchemaNode[],
  depth: number,
  collapsed: Set<string>,
): void {
  for (const node of nodes) {
    const itemKey = `${parentKey}/${node.name}`;
    rows.push({ kind: 'component-prop-node', itemKey, node, depth });
    const isFolderNode = node.kind === 'folder' || node.kind === 'array';
    if (isFolderNode && !!node.children?.length && !collapsed.has(itemKey)) {
      appendComponentPropNodeRows(rows, itemKey, node.children, depth + 1, collapsed);
    }
  }
}
