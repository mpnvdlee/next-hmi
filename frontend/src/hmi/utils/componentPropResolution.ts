import type { ComponentPropertySchema } from '@shared/types/componentProperty';
import { isRecord, isVarSource } from '@shared/types/propertyValueGuards';

export function resolveComponentPropValue(
  value: unknown,
  scope: Record<string, unknown> | undefined,
): unknown {
  if (!scope) return value;
  if (!isRecord(value)) return value;
  const propKey = '$componentProp' in value ? value.$componentProp : undefined;
  if (propKey === undefined) return value;
  if (typeof propKey !== 'string') return value;
  return resolveComponentPropKey(propKey, scope);
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
