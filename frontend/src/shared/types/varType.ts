/**
 * Canonical variable-type model + compatibility predicate.
 *
 * A variable's type is described by exactly one structured value: array-ness
 * lives only in `VarType.array` (never a `[]` string suffix, never a
 * `kind: 'struct[]'` discriminant). Both the runtime binding validator
 * (`bindingValidation.ts`) and the config binding picker decide "does this
 * variable satisfy this schema slot?" through the single `accepts` predicate,
 * so "selectable in the picker" and "valid at runtime" can never diverge.
 */

import type { RequiredFieldEntry } from './widgetSchema';
import { VALUE_TYPES } from '../utils/valueTypes';

type SimpleBase = (typeof VALUE_TYPES)[number];

/** The type of an actual variable (or a resolved array element). */
export type VarType =
  | { kind: 'scalar'; base: SimpleBase; array: boolean; length?: number }
  | { kind: 'struct'; name: string; fields: string[]; array: boolean };

/** A schema slot's accepted type, parsed from one authored token. */
export interface AcceptType {
  kind: 'scalar' | 'struct';
  /** Present for scalar accepts only. */
  base?: SimpleBase;
  array: boolean;
}

const BASE_BY_LOWER = new Map<string, SimpleBase>(
  VALUE_TYPES.map((base) => [base.toLowerCase(), base]),
);

/** Canonicalise a simple-type name (case-insensitive); unknown → 'String'. */
export function canonicalBase(name: string): SimpleBase {
  return BASE_BY_LOWER.get(name.trim().toLowerCase()) ?? 'String';
}

/**
 * Parse one authored schema token (`'float'`, `'string[]'`, a struct name, or a
 * struct name + `[]`) into a structured accept spec. The only place the
 * `[]`-suffix authoring sugar is interpreted.
 */
export function parseTypeToken(token: string): AcceptType {
  const array = token.endsWith('[]');
  const bare = array ? token.slice(0, -2) : token;
  const base = BASE_BY_LOWER.get(bare.trim().toLowerCase());
  return base ? { kind: 'scalar', base, array } : { kind: 'struct', array };
}

/** The element type of an array (drops array-ness); identity for scalars. */
export function elementOf(t: VarType): VarType {
  if (!t.array) return t;
  if (t.kind === 'scalar') {
    return { kind: 'scalar', base: t.base, array: false };
  }
  return { ...t, array: false };
}

function fieldName(f: RequiredFieldEntry): string {
  return typeof f === 'string' ? f : f.name;
}

/**
 * Strict compatibility: does a variable of type `v` satisfy a slot that
 * accepts `a`? Array-ness must match exactly — an indexed binding must be
 * resolved with `elementOf` before calling this.
 *
 * Struct field-shape is decided from metadata `fields`, never a live value's
 * runtime shape, so an empty `struct[]` (zero elements, no field info yet) is
 * still accepted.
 */
export function accepts(a: AcceptType, v: VarType, requiredFields?: RequiredFieldEntry[]): boolean {
  if (a.array !== v.array) return false;
  if (a.kind === 'scalar') return v.kind === 'scalar' && a.base === v.base;
  if (v.kind !== 'struct') return false;
  if (requiredFields && requiredFields.length > 0 && v.fields.length > 0) {
    return requiredFields.every((f) => v.fields.includes(fieldName(f)));
  }
  return true;
}

/**
 * Picker-tree leniency: a browsable node is shown when the slot accepts it
 * directly, or — for a scalar slot — when it's an array whose element the slot
 * would accept (the user drills in and picks `value[i]`).
 */
export function nodeAcceptsOrElement(a: AcceptType, v: VarType): boolean {
  return accepts(a, v) || (!a.array && v.array && accepts(a, elementOf(v)));
}

/** Minimal datasource-node shape needed to derive a VarType. */
interface VarTypeNode {
  data_type: string;
  is_array?: boolean;
  array_length?: number;
  fields?: Record<string, string>;
}

/** Derive a VarType from a datasource tree/registry node (bare `data_type` + flags). */
export function nodeVarType(n: VarTypeNode): VarType {
  const array = n.is_array === true;
  if (n.data_type === 'struct') {
    return { kind: 'struct', name: 'struct', array, fields: n.fields ? Object.keys(n.fields) : [] };
  }
  return {
    kind: 'scalar',
    base: canonicalBase(n.data_type),
    array,
    ...(array && typeof n.array_length === 'number' && n.array_length > 0
      ? { length: n.array_length }
      : {}),
  };
}

/** Human-readable type label, e.g. "Integer[]", "Alarm[]". */
export function formatVarType(t: VarType): string {
  const name = t.kind === 'scalar' ? t.base : t.name;
  return t.array ? `${name}[]` : name;
}
