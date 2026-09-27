import type { SchemaField } from '@shared/types/widgetSchema';
import type { VariableBinding } from '@shared/types/config';
import { varBindingOf } from '../../bindingPickerUtils';

/** `currentBinding` is the binding the *calling slot* already holds, so the
 *  picker opens on it. It travels as an argument rather than being resolved by
 *  the opener because a nested slot (an `$if` branch, a `$switch` case, a
 *  `$stringExpr` wildcard) lives inside the property value — the opener only
 *  ever sees the property's top-level value.
 *
 *  `anyType` marks a slot that formats whatever it gets — a `$stringExpr` or
 *  `$http` wildcard — so the property's own type does not constrain it. */
export type OpenBindingPicker = (
  onPick?: (binding: VariableBinding) => void,
  currentBinding?: VariableBinding,
  anyType?: boolean,
) => void;

/**
 * What a nested slot takes, in place of the property's type, access and
 * required fields — those describe the property, not an operand inside it.
 * `true` takes any type: a slot that formats whatever it gets (a `$stringExpr`
 * or `$http` wildcard) or judges it by loose equality (a `$compare` operand, a
 * `$switch` value). `{ type }` takes that type, read-only: a `$formula` operand
 * takes a number, a condition a Boolean.
 */
export type SlotType = true | { type: string | string[] };

/** What a `$formula` operand takes: the formula coerces each one to a number. */
export const NUMERIC_TYPES: SchemaField['type'] = ['Float', 'Integer'];
export const NUMERIC_SLOT: SlotType = { type: NUMERIC_TYPES };

/** What a condition takes (an `$if`'s, an If action's, what `$not` inverts):
 *  a Boolean, not any value's truthiness — an Integer tests through `$compare`. */
export const BOOLEAN_SLOT: SlotType = { type: 'Boolean' };

/** The picker filter for a slot: the property's own, or — for a slot with a
 *  type of its own — the property's label over the slot's type. */
export function slotFilter<F extends { label?: string }>(
  filter: F,
  anyType?: boolean,
): F | { label?: string } {
  return anyType ? { label: filter.label } : filter;
}

/**
 * Wraps a parent binding picker so that when a binding is picked the `apply`
 * callback is called first (to patch the value), then the caller's onPick.
 *
 * `current` is the wrapped slot's own value: it becomes the preselect whenever
 * a deeper wrap doesn't supply one of its own, so the innermost slot that knows
 * its binding always wins. `slot` follows the same rule: an `$if` branch inside
 * a `$formula` operand takes a number, a `$formula` inside an `$if` condition
 * still hands its operands a number.
 */
export function wrapPicker(
  parent: OpenBindingPicker | undefined,
  apply: (b: VariableBinding) => void,
  current?: unknown,
  slot?: SlotType,
): OpenBindingPicker | undefined {
  if (!parent) return undefined;
  return (onPick, currentBinding, slotAnyType) =>
    parent(
      (b) => {
        apply(b);
        onPick?.(b);
      },
      currentBinding ?? varBindingOf(current),
      slotAnyType ?? anyType,
    );
}

export const OPERATORS = [
  { value: '<', label: '<' },
  { value: '<=', label: '≤' },
  { value: '===', label: '=' },
  { value: '!==', label: '≠' },
  { value: '>=', label: '≥' },
  { value: '>', label: '>' },
] as const;

export type Operator = (typeof OPERATORS)[number]['value'];

/**
 * Schema used for both operands of $compare and the value of $switch.
 * String-typed so the static editor accepts non-numeric values like
 * 'phone'/'tablet'/'laptop' (the evaluator's toNumber() still coerces numeric
 * strings for arithmetic operators).
 */
export const COMPARE_OPERAND_SCHEMA: SchemaField = {
  type: 'String',
  label: 'Value',
};
