/**
 * bindingPickerUtils — accessors for `RequiredFieldEntry`, which is either
 * a bare field name or an object with `type` / `write` / nested fields, plus
 * the `$var` reader the binding-picker openers use to preselect.
 */

import type { VariableBinding } from '@shared/types/config';
import type { RequiredFieldEntry } from '@shared/types/widgetSchema';
export type { RequiredFieldEntry };

/** The `$var` binding a property value carries, if it is bound to a variable.
 *  Openers pass it to `openBindingPicker` as `currentBinding` so the picker
 *  opens on the variable the field already uses. */
export function varBindingOf(value: unknown): VariableBinding | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const wrapped = (value as { $var?: VariableBinding }).$var;
  return wrapped && typeof wrapped.path === 'string' && wrapped.path ? wrapped : undefined;
}

export function rfName(f: RequiredFieldEntry): string {
  return typeof f === 'string' ? f : f.name;
}

export function rfType(f: RequiredFieldEntry): string | undefined {
  return typeof f === 'string' ? undefined : f.type;
}

export function rfNeedsWrite(f: RequiredFieldEntry): boolean {
  return typeof f !== 'string' && f.write === true;
}

export function rfNestedFields(f: RequiredFieldEntry): RequiredFieldEntry[] | undefined {
  return typeof f === 'string' ? undefined : f.requiredFields;
}
