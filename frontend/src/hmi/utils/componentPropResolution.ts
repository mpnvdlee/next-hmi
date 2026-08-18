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
