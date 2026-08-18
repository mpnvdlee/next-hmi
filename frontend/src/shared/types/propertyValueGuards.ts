import type { VariableBinding } from './config';

type UnknownRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isVariableBinding(value: unknown): value is VariableBinding {
  if (!isRecord(value)) return false;
  return typeof value.path === 'string' && value.path.length > 0;
}

export function isVarSource(value: unknown): value is { $var: VariableBinding } {
  if (!isRecord(value) || !('$var' in value)) return false;
  return isVariableBinding((value as { $var?: unknown }).$var);
}

export function getVarBinding(value: unknown): VariableBinding | undefined {
  return isVarSource(value) ? value.$var : undefined;
}

export function hasPropertySourceKey(value: unknown): value is UnknownRecord {
  if (!isRecord(value)) return false;
  return Object.keys(value).some((k) => k.startsWith('$'));
}

export function isLocSource(value: unknown): value is { $loc: string } {
  return isRecord(value) && typeof value.$loc === 'string';
}

export function isHttpSource(value: unknown): value is { $http: UnknownRecord } {
  return isRecord(value) && isRecord((value as { $http?: unknown }).$http);
}

export function isTimeSource(value: unknown): value is { $time: UnknownRecord } {
  // A functional `$time` source always carries an options record payload
  // (`evaluateTime` returns null for a non-object payload), so requiring one
  // avoids false-positives on an unrelated object that merely has a `$time` key.
  return isRecord(value) && isRecord((value as { $time?: unknown }).$time);
}
