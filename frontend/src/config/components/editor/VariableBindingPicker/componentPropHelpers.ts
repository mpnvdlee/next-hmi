import type { StructSchemaNode, ComponentPropertySchema } from '@shared/types/componentProperty';
import { type RequiredFieldEntry } from '../bindingPickerUtils';
import { structSchemaMatchesRequired } from './helpers';
import type { RowItem } from './variableTreeHelpers';
import { isStructType, primaryType, typeList } from '@shared/utils/valueTypes';
import { matchesSearchWords } from '@shared/utils/search';

/** Lowercase tokens for a merged type; 'select' provides a string value. */
function typeTokens(t: string | string[]): string[] {
  return typeList(t).map((x) => {
    const lower = x.toLowerCase();
    return lower === 'select' ? 'string' : lower;
  });
}

/** True when a field's merged type expects a struct binding. */
export function isStructTarget(fieldType: string | string[]): boolean {
  return isStructType(primaryType(fieldType));
}

/** Returns true when a component property is compatible with a component schema field. */
export function isCompatible(
  prop: ComponentPropertySchema,
  fieldType: string | string[],
  requiredFields?: RequiredFieldEntry[],
): boolean {
  if (isStructTarget(fieldType)) {
    if (!isStructType(primaryType(prop.type))) return false;
    if (
      requiredFields?.length &&
      (!prop.structSchema || !structSchemaMatchesRequired(prop.structSchema, requiredFields))
    ) {
      return false;
    }
    return true;
  }
  const fieldTokens = typeTokens(fieldType);
  const propTokens = typeTokens(prop.type);
  return fieldTokens.some((f) => propTokens.includes(f));
}

export function isCompatibleFolderNode(
  node: StructSchemaNode,
  fieldType: string | string[],
  requiredFields?: RequiredFieldEntry[],
): boolean {
  if (!isStructTarget(fieldType)) return false;
  if (node.kind !== 'folder' && node.kind !== 'array') return false;
  return (
    !requiredFields?.length || structSchemaMatchesRequired(node.children ?? [], requiredFields)
  );
}

export function isCompatibleLeafNode(
  node: StructSchemaNode,
  fieldType: string | string[],
): boolean {
  if (isStructTarget(fieldType)) return false;
  if (node.kind !== 'variable') return false;
  if (node.type) {
    const fieldTokens = typeTokens(fieldType);
    return fieldTokens.includes(node.type.toLowerCase());
  }
  return true;
}

function hasCompatibleDescendant(
  nodes: StructSchemaNode[],
  fieldType: string | string[],
  requiredFields?: RequiredFieldEntry[],
): boolean {
  for (const node of nodes) {
    if (node.kind === 'variable' && isCompatibleLeafNode(node, fieldType)) return true;
    if (
      (node.kind === 'folder' || node.kind === 'array') &&
      isCompatibleFolderNode(node, fieldType, requiredFields)
    )
      return true;
    if (node.children?.length && hasCompatibleDescendant(node.children, fieldType, requiredFields))
      return true;
  }
  return false;
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
      const directlyOk = isCompatible(schema, fieldType, requiredFields);
      if (!directlyOk) {
        const hasDesc =
          isStructType(primaryType(schema.type)) &&
          !!schema.structSchema?.length &&
          hasCompatibleDescendant(schema.structSchema, fieldType, requiredFields);
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
