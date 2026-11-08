import { inputMode, type ComponentPropertySchema } from '@shared/types/componentProperty';
import { isRecord, isVarSource } from '@shared/types/propertyValueGuards';
import { isWidgetNode } from './repeatItemResolution';

/**
 * Swap every `$componentProp` in `value`, at any depth, for what the scope
 * passed. Done before evaluation so a forwarded `$var` nested in a `$if` /
 * `$compare` / `$stringExpr` is an ordinary `$var` that `extractVarKeys` sees
 * and subscribes to. A widget node kept in a property resolves its own, and
 * unchanged subtrees keep their identity.
 */
export function resolveComponentPropValue(
  value: unknown,
  scope: Record<string, unknown> | undefined,
): unknown {
  if (!scope) return value;
  if (isRecord(value) && typeof value.$componentProp === 'string') {
    return resolveComponentPropKey(value.$componentProp, scope);
  }
  return substituteNested(value, scope);
}

function substituteNested(value: unknown, scope: Record<string, unknown>): unknown {
  if (Array.isArray(value)) {
    const out = value.map((v) => substituteNested(v, scope));
    return out.some((v, i) => v !== value[i]) ? out : value;
  }
  if (!isRecord(value) || isWidgetNode(value)) return value;
  if (typeof value.$componentProp === 'string') {
    // An unset input stays a reference: the evaluator reads it as no value, as
    // it always did, where `undefined` would drop a `$compare` operand.
    return resolveComponentPropKey(value.$componentProp, scope) ?? value;
  }
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = substituteNested(v, scope);
    if (out[k] !== v) changed = true;
  }
  return changed ? out : value;
}

export function resolveComponentPropKey(propKey: string, scope: Record<string, unknown>): unknown {
  const slashIdx = propKey.indexOf('/');
  if (slashIdx === -1) return scope[propKey];

  const parentKey = propKey.slice(0, slashIdx);
  const subPath = propKey.slice(slashIdx + 1);
  const parent = scope[parentKey];
  if (!isVarSource(parent)) return undefined;

  const v = parent.$var;
  return { $var: { ...v, path: `${v.path}/${subPath}` } };
}

/**
 * Fill in the declared default for every property the instance left unset.
 *
 * Without this a default is a lie: the properties panel prints it as the field's
 * `· default` hint and the components editor's preview mocks it in, while the
 * real page resolves `$componentProp` to nothing and the widget reading it
 * renders blank.
 *
 * `null` is a set value (an author clearing a field on purpose), so only
 * `undefined` falls through to the default.
 */
export function withDeclaredDefaults(
  properties: Record<string, unknown> | undefined,
  declared: Record<string, ComponentPropertySchema> | undefined,
): Record<string, unknown> {
  const merged = { ...(properties ?? {}) };
  for (const [key, schema] of Object.entries(declared ?? {})) {
    if (merged[key] === undefined && schema?.defaultValue !== undefined) {
      merged[key] = schema.defaultValue;
    }
  }
  return merged;
}

/**
 * One local slot per declared Value input, starting from what `supplied` holds
 * for it — the value passed in, a default already layered under it. `prefix`
 * keeps the slots of several declaring nodes in one frame apart.
 */
export function valueInputSeeds(
  declared: Record<string, ComponentPropertySchema> | undefined,
  supplied: Record<string, unknown> | undefined,
  prefix = '',
): { slot: string; source: unknown }[] {
  return Object.entries(declared ?? {})
    .filter(([, schema]) => schema && inputMode(schema) === 'value')
    .map(([key]) => ({ slot: `${prefix}${key}`, source: supplied?.[key] }));
}
