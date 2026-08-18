/**
 * Visibility condition evaluation utilities
 *
 * Supports evaluating VisibilityCondition objects to determine
 * whether a field should be shown or hidden based on other property values.
 */

import type { VisibilityCondition } from '@shared/types/config';

/**
 * Evaluate a single visibility condition.
 *
 * Returns true if the visibility condition is satisfied (field should be visible).
 */
function evaluateVisibilityCondition(
  condition: VisibilityCondition,
  properties: Record<string, unknown>,
): boolean {
  const fieldValue = properties[condition.property];

  if (condition.equals !== undefined) {
    // equals condition: field is visible if property === equals value
    return fieldValue === condition.equals;
  }

  if (condition.notEquals !== undefined) {
    // notEquals condition: field is visible if property !== notEquals value
    return fieldValue !== condition.notEquals;
  }

  // If no equals/notEquals, default to true
  return true;
}

/**
 * Evaluate a visibility condition that can be a single condition or array of conditions.
 *
 * When array: all conditions must be true (AND logic)
 * When single: just evaluate the single condition
 */
export function evaluateVisibility(
  visibleWhen: VisibilityCondition | VisibilityCondition[] | undefined,
  properties: Record<string, unknown>,
): boolean {
  if (!visibleWhen) {
    return true; // No visibility condition means always visible
  }

  if (Array.isArray(visibleWhen)) {
    // All conditions must be true (AND logic)
    return visibleWhen.every((cond) => evaluateVisibilityCondition(cond, properties));
  }

  // Single condition
  return evaluateVisibilityCondition(visibleWhen, properties);
}
