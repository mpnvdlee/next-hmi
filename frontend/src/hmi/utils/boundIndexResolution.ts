import { isBoundIndex, type VariableBinding } from '@shared/types/config';
import { isVarSource } from '@shared/types/propertyValueGuards';
import { isWidgetNode, memberLeafKey } from './repeatItemResolution';

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
  return mapVarSources(value, (source) => {
    const { index } = source.$var;
    return isBoundIndex(index)
      ? { ...source, $var: { ...source.$var, index: resolve(index) } }
      : source;
  });
}

/**
 * Rewrite every `$var` naming a member of one struct-array element through the
 * array (`{ path: 'PLC:Motors/sName', index: 1 }`, what `device/sName` makes of
 * an input passing `PLC:Motors` at 1) into that member's own leaf, so it reads,
 * writes and validates as any variable. Unchanged subtrees keep their identity.
 */
export function substituteMemberLeaves(value: unknown, varMeta: Record<string, unknown>): unknown {
  return mapVarSources(value, (source) => {
    const { index, ...binding } = source.$var;
    const leaf =
      typeof index === 'number' ? memberLeafKey(varMeta, binding.path, index) : undefined;
    return leaf === undefined ? source : { ...source, $var: { ...binding, path: leaf } };
  });
}

/** `value` with each `$var` swapped for what `map` makes of it. A widget node
 *  kept inside a property is skipped: it resolves its own, in its own scope. */
function mapVarSources(
  value: unknown,
  map: (source: { $var: VariableBinding }) => unknown,
): unknown {
  if (Array.isArray(value)) {
    const out = value.map((v) => mapVarSources(v, map));
    return out.some((v, i) => v !== value[i]) ? out : value;
  }
  if (!value || typeof value !== 'object' || isWidgetNode(value)) return value;
  if (isVarSource(value)) return map(value);
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = mapVarSources(v, map);
    if (out[k] !== v) changed = true;
  }
  return changed ? out : value;
}
