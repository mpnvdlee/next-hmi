/**
 * Simple-type vocabulary and classifier — the single source of truth for the
 * datatypes the user and HMI config speak. Real OPC-UA types live only in the
 * OPC layer and are converted to these at the HMI boundaries.
 */

export const VALUE_TYPES = [
  'Boolean',
  'Integer',
  'Float',
  'String',
  'DateTime',
  'Date',
  'Time',
  'Duration',
] as const;

// Case-insensitive lookup: lower-cased value type -> canonical (capitalised) form.
const CANONICAL_BY_LOWER: Record<string, string> = Object.fromEntries(
  VALUE_TYPES.map((t) => [t.toLowerCase(), t]),
);

export const EDITOR_KINDS = [
  'color',
  'icon',
  'image',
  'option-list',
  'actions',
  'groups',
  'image-indicators',
  'child-positions',
  'menu-items',
  'page-group',
  'slot',
  'widgets',
  '_action',
] as const;

// Lower-cased real OPC-UA type -> simple type. Mirrors backend OPCUA_TO_SIMPLE.
const OPCUA_TO_SIMPLE: Record<string, string> = {
  boolean: 'Boolean',
  bool: 'Boolean',
  sbyte: 'Integer',
  byte: 'Integer',
  int8: 'Integer',
  int16: 'Integer',
  int32: 'Integer',
  int64: 'Integer',
  uint8: 'Integer',
  uint16: 'Integer',
  uint32: 'Integer',
  uint64: 'Integer',
  enumeration: 'Integer',
  float: 'Float',
  single: 'Float',
  double: 'Float',
  decimal: 'Float',
  string: 'String',
  bytestring: 'String',
  guid: 'String',
  nodeid: 'String',
  datetime: 'DateTime',
  date: 'Date',
  time: 'Time',
  duration: 'Duration',
  timespan: 'Duration',
};

/** Map a real OPC-UA type to its simple type (idempotent; unknown -> String). */
export function toSimpleType(opcuaType: string | undefined): string {
  const key = (opcuaType ?? '').trim().toLowerCase();
  if (key in CANONICAL_BY_LOWER) return CANONICAL_BY_LOWER[key];
  return OPCUA_TO_SIMPLE[key] ?? 'String';
}

// Simple type (lower-cased) -> representative OPC-UA type (for synthesis on static/sim). Mirrors backend.
const SIMPLE_TO_REPRESENTATIVE: Record<string, string> = {
  integer: 'Int32',
  float: 'Double',
  boolean: 'Boolean',
  string: 'String',
  datetime: 'DateTime',
  date: 'DateTime',
  time: 'DateTime',
  duration: 'Double',
};

/** Map a simple type to its representative OPC-UA type (for the static/sim datasource). */
export function representativeOpcuaType(simpleType: string): string {
  return SIMPLE_TO_REPRESENTATIVE[simpleType.trim().toLowerCase()] ?? 'String';
}

// Concrete OPC-UA types the test server can synthesise (mirrors backend
// _VARIANT_MAP). Used by the test-server editor so the user picks the exact
// wire type rather than only a simple type.
export const OPCUA_TYPES = [
  'Boolean',
  'SByte',
  'Byte',
  'Int16',
  'UInt16',
  'Int32',
  'UInt32',
  'Int64',
  'UInt64',
  'Float',
  'Double',
  'String',
  'DateTime',
] as const;

const OPCUA_TYPE_ALIASES: Record<string, string> = {
  bool: 'Boolean',
  int8: 'SByte',
  uint8: 'Byte',
  single: 'Float',
};

/** Normalise a raw OPC-UA type to one of OPCUA_TYPES (canonical casing). */
export function canonicalOpcuaType(raw: string | undefined): string {
  const key = (raw ?? '').trim();
  const lower = key.toLowerCase();
  const match = (OPCUA_TYPES as readonly string[]).find((t) => t.toLowerCase() === lower);
  return match ?? OPCUA_TYPE_ALIASES[lower] ?? 'Float';
}

/** True when the simple or raw OPC-UA type resolves to a numeric simple type. */
export const isNumericType = (t: string): boolean => {
  const simple = toSimpleType(t);
  return simple === 'Integer' || simple === 'Float';
};

export const baseType = (t: string): string => (t.endsWith('[]') ? t.slice(0, -2) : t);
export const isArrayType = (t: string): boolean => t.endsWith('[]');
export const isScalarType = (t: string): boolean => baseType(t).toLowerCase() in CANONICAL_BY_LOWER;
export const isEditorKind = (t: string): boolean => (EDITOR_KINDS as readonly string[]).includes(t);
/** A named struct (or array of named struct): not a simple type, not an editor kind. */
export const isStructType = (t: string): boolean => !isScalarType(t) && !isEditorKind(t);

// A field's `type` may be a single value or a list:
export const typeList = (t: string | string[]): string[] => (Array.isArray(t) ? t : [t]);
// Primary entry drives the *editor control*; all non-editor entries form the *binding filter*.
export const primaryType = (t: string | string[]): string => typeList(t)[0];
export const acceptedValueTypes = (t: string | string[]): string[] =>
  typeList(t).filter((x) => !isEditorKind(x));
