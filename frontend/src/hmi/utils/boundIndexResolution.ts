import { isBoundIndex } from '@shared/types/config';
import { isVarSource } from '@shared/types/propertyValueGuards';
import { isWidgetNode } from './repeatItemResolution';

/**
 * Every bound `$var.index` in a property value, in walk order. A widget node
 * kept inside a property is skipped: it resolves its own, in its own scope.
 */
export function collectBoundIndexes(value: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    for (const v of value) collectBoundIndexes(v, out);
  } else if (value && typeof value === 'object' && !isWidgetNode(value)) {
    if (isVarSource(value)) {
      if (isBoundIndex(value.$var.index)) out.push(value.$var.index);
    } else {
      for (const v of Object.values(value)) collectBoundIndexes(v, out);
    }
  }
  return out;
}

/**
 * Rewrite every bound `$var.index` into the number `resolve` gives it, so
 * everything downstream — the live subscription, the widget's own writer, an
 * action's target — sees an ordinary indexed `$var`. Unchanged subtrees keep
 * their identity.
 */
export function substituteBoundIndexes(
  value: unknown,
  resolve: (index: unknown) => number,
): unknown {
  if (Array.isArray(value)) {
    const out = value.map((v) => substituteBoundIndexes(v, resolve));
    return out.some((v, i) => v !== value[i]) ? out : value;
  }
  if (!value || typeof value !== 'object' || isWidgetNode(value)) return value;
  if (isVarSource(value)) {
    const { index } = value.$var;
    return isBoundIndex(index)
      ? { ...value, $var: { ...value.$var, index: resolve(index) } }
      : value;
  }
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = substituteBoundIndexes(v, resolve);
    if (out[k] !== v) changed = true;
  }
  return changed ? out : value;
}
