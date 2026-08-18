/**
 * Helpers shared between the main VariableBindingPicker module and its
 * RightPanel subcomponent.
 */

import type {
  PickerFolderEntry,
  PickerVariableEntry,
  PickerTreeNode,
} from '@config/components/ui/datasourceTreeHelpers';
import { isFolder } from '@shared/types/datasource';
import type { StructSchemaNode } from '@shared/types/componentProperty';
import {
  rfName,
  rfType,
  rfNeedsWrite,
  rfNestedFields,
  type RequiredFieldEntry,
} from '../bindingPickerUtils';

export function formatTypeBadge(type: string | string[]): string {
  return Array.isArray(type) ? type.join(', ') : type;
}

/** True if a folder's children cover all required field names (recursively for nested structs). */
export function hasRequiredFields(
  folder: PickerFolderEntry,
  requiredFields: RequiredFieldEntry[],
): boolean {
  const children = folder.children as PickerTreeNode[];
  const childVarNames = children
    .filter((c): c is PickerVariableEntry => !isFolder(c))
    .map((c) => c.display_name);
  const childFoldersByName = new Map(
    children.filter((c): c is PickerFolderEntry => isFolder(c)).map((c) => [c.name, c]),
  );

  return requiredFields.every((f) => {
    const name = rfName(f);
    const nested = rfNestedFields(f);
    if (nested?.length) {
      const subFolder = childFoldersByName.get(name);
      return subFolder ? hasRequiredFields(subFolder, nested) : false;
    }
    return childVarNames.includes(name);
  });
}

/**
 * True when a StructSchemaNode tree covers all entries in requiredFields.
 * Mirrors hasRequiredFields() but operates on StructSchemaNode instead of the OPC-UA tree.
 */
export function structSchemaMatchesRequired(
  nodes: StructSchemaNode[],
  fields: RequiredFieldEntry[],
): boolean {
  return fields.every((f) => {
    const name = rfName(f);
    const nested = rfNestedFields(f);
    const expectedType = rfType(f);
    const needsWrite = rfNeedsWrite(f);
    const node = nodes.find((n) => n.name === name);
    if (!node) return false;
    if (nested?.length) {
      if (node.kind !== 'folder' && node.kind !== 'array') return false;
      return structSchemaMatchesRequired(node.children ?? [], nested);
    }
    if (expectedType && node.type) {
      if (node.type.toLowerCase() !== expectedType.toLowerCase()) return false;
    }
    if (needsWrite && node.write !== true) return false;
    return true;
  });
}
