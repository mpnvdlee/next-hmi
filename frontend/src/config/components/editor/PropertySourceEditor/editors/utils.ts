import type { SchemaField } from '@shared/types/widgetSchema';
import type { VariableBinding } from '@shared/types/config';
import { varBindingOf } from '../../bindingPickerUtils';

/** `currentBinding` is the binding the *calling slot* already holds, so the
 *  picker opens on it. It travels as an argument rather than being resolved by
 *  the opener because a nested slot (an `$if` branch, a `$switch` case, a
 *  `$stringExpr` wildcard) lives inside the property value — the opener only
 *  ever sees the property's top-level value. */
export type OpenBindingPicker = (
  onPick?: (binding: VariableBinding) => void,
  currentBinding?: VariableBinding,
) => void;

/**
 * Wraps a parent binding picker so that when a binding is picked the `apply`
 * callback is called first (to patch the value), then the caller's onPick.
 *
 * `current` is the wrapped slot's own value: it becomes the preselect whenever
 * a deeper wrap doesn't supply one of its own, so the innermost slot that knows
 * its binding always wins.
 */
export function wrapPicker(
  parent: OpenBindingPicker | undefined,
  apply: (b: VariableBinding) => void,
  current?: unknown,
): OpenBindingPicker | undefined {
  if (!parent) return undefined;
  return (onPick, currentBinding) =>
    parent(
      (b) => {
        apply(b);
        onPick?.(b);
      },
      currentBinding ?? varBindingOf(current),
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
