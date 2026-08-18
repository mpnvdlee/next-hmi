/**
 * Shared binding-validation utilities used by both the runtime overlay
 * (ComponentRenderer) and the editor properties panel (PropertiesPanel).
 *
 * The single source of truth for "is this variable binding compatible with
 * this schema field?" lives here, so the editor's ! indicator and the HMI's
 * red-cross overlay always agree.
 */

import { getPropBinding } from '../components/layoutUtils';
import { bindingKey } from '@shared/types/config';
import type { RequiredFieldEntry } from '@shared/types/widgetSchema';
import { accepts, elementOf, parseTypeToken, type AcceptType } from '@shared/types/varType';
import { acceptedValueTypes } from '@shared/utils/valueTypes';
import { useVariableStore } from '../store/variableStore';
import type { VarMeta } from '../store/variableStore';
import { useMemo } from 'react';

// ── Types ────────────────────────────────────────────────────────────────────

/** Per-field binding descriptor extracted from a component's property map. */
export interface BindingSpec {
  id: string;
  /** Array element selected by `$var.index`, when present. */
  index?: number;
  /** Schema slot's accepted types (empty = no type constraint). */
  accept: AcceptType[];
  requiredFields?: RequiredFieldEntry[];
}

/** Parse a schema field's `type` into the slot's accepted-type list. */
function acceptTypes(type: string | string[] | undefined): AcceptType[] {
  if (type === undefined) return [];
  return acceptedValueTypes(type).map(parseTypeToken);
}

/** Minimal store slice needed for binding validation. */
export interface BindingStoreSlice {
  values: Record<string, unknown>;
  varMeta: Record<string, VarMeta>;
  metadataReceived: boolean;
  wsConnected: boolean;
  opcuaConnected: Record<string, boolean>;
  snapshotReceived: boolean;
}

// ── Extraction ───────────────────────────────────────────────────────────────

/** Convert a component's property map + schema into per-field BindingSpecs. */
export function extractBindingSpecs(
  properties: Record<string, unknown> | undefined,
  schema: Record<string, { type: string | string[]; requiredFields?: RequiredFieldEntry[] }>,
): BindingSpec[] {
  if (!properties) return [];
  const specs: BindingSpec[] = [];
  for (const key of Object.keys(properties)) {
    const b = getPropBinding(properties, key);
    if (!b) continue;
    const id = bindingKey(b);
    if (!id) continue;
    const field = schema[key];
    specs.push({
      id,
      index: b.index,
      accept: acceptTypes(field?.type),
      requiredFields: field?.requiredFields,
    });
  }
  return specs;
}

// ── Per-binding check ─────────────────────────────────────────────────────────

/**
 * Validate a single binding against store state.
 *
 * Shape/type validation is decided from the authoritative `varMeta[id].type`
 * — never from sniffing the live value's runtime shape. An indexed binding is
 * resolved to its element type first, so `EventCounters[3]` (an `Integer[]`
 * element) validates against a scalar `Integer` slot. A `struct[]` with zero
 * current elements is still valid (metadata carries the shape).
 *
 * Returns:
 *  - `'ok'`      — binding is present and compatible with the schema field
 *  - `'invalid'` — binding is definitively wrong (wrong shape, missing, or type
 *                  mismatch); triggers the red-cross overlay / ! badge
 *  - `'pending'` — metadata says the binding is valid but no live value has
 *                  arrived yet; caller should treat as "data still loading"
 */
export function checkBindingSpec(
  spec: BindingSpec,
  s: BindingStoreSlice,
  hasMeta: boolean,
): 'ok' | 'invalid' | 'pending' {
  const { id, index, accept, requiredFields } = spec;
  const meta = s.varMeta[id];

  if (!meta) {
    // Not in metadata. If metadata has been received, the variable does not
    // exist in any datasource (missing or not enabled).
    if (hasMeta) return 'invalid';
    return 'pending'; // metadata not yet received — don't flag anything
  }

  if (index !== undefined) {
    if (!Number.isInteger(index) || index < 0 || !meta.type.array) return 'invalid';
    if (
      meta.type.kind === 'scalar' &&
      meta.type.length !== undefined &&
      index >= meta.type.length
    ) {
      return 'invalid';
    }
  }

  if (accept.length > 0) {
    const value = index === undefined ? meta.type : elementOf(meta.type);
    if (!accept.some((a) => accepts(a, value, requiredFields))) return 'invalid';
  }

  const valueId = index !== undefined && meta.type.kind === 'struct' ? `${id}/[${index}]` : id;
  if (!(valueId in s.values)) return 'pending';
  if (index !== undefined && meta.type.kind === 'scalar') {
    const value = s.values[id];
    if (!Array.isArray(value) || index >= value.length) return 'pending';
  }
  return 'ok';
}

/**
 * Aggregate multiple BindingSpecs into a single component-level status.
 * Used by ComponentRenderer to decide whether to show the overlay and which variant.
 */
export function aggregateBindingStatus(
  bindingSpecs: BindingSpec[],
  s: BindingStoreSlice,
): 'ok' | 'disabled' | 'disconnected' {
  if (bindingSpecs.length === 0) return 'ok';

  // Connectivity is authoritative even while the last values remain cached.
  // Never present stale values as healthy after WS/OPC-UA disconnect.
  if (!s.wsConnected) return 'disconnected';
  const anyDsDisconnected = bindingSpecs.some(({ id }) => {
    const ds = id.split(':')[0];
    return ds in s.opcuaConnected && !s.opcuaConnected[ds];
  });
  if (anyDsDisconnected) return 'disconnected';

  let allPresent = true;

  for (const spec of bindingSpecs) {
    const result = checkBindingSpec(spec, s, s.metadataReceived);
    if (result === 'invalid') return 'disabled';
    if (result === 'pending') allPresent = false;
  }

  if (allPresent) return 'ok';

  if (s.snapshotReceived) return 'disabled';
  return 'disconnected'; // still waiting for first snapshot
}

// ── Component-level binding status hook ──────────────────────────────────────

/**
 * Build a memoizing selector over `bindingSpecs`: the O(bindingSpecs.length)
 * `aggregateBindingStatus` recompute only runs when a store update actually
 * touched something a spec depends on (its value/meta, a referenced
 * datasource's opcua-connected flag, or the global ws/snapshot flags) —
 * unrelated store updates (e.g. another datasource entirely) return the
 * cached result without scanning bindingSpecs at all.
 *
 * `onRecompute` is test instrumentation only; production callers omit it.
 */
export function createBindingStatusSelector(
  bindingSpecs: BindingSpec[],
  onRecompute?: () => void,
): (s: BindingStoreSlice) => 'ok' | 'disabled' | 'disconnected' {
  if (bindingSpecs.length === 0) return () => 'ok';

  const depIds = Array.from(new Set(bindingSpecs.map((spec) => spec.id)));
  const depValueIds = Array.from(
    new Set(
      bindingSpecs.flatMap((spec) =>
        spec.index === undefined ? [spec.id] : [spec.id, `${spec.id}/[${spec.index}]`],
      ),
    ),
  );
  const depDatasources = Array.from(new Set(depIds.map((id) => id.split(':')[0])));

  let cache: {
    values: Record<string, unknown>;
    varMeta: Record<string, VarMeta>;
    metadataReceived: boolean;
    wsConnected: boolean;
    snapshotReceived: boolean;
    opcuaConnected: Record<string, boolean>;
    result: 'ok' | 'disabled' | 'disconnected';
  } | null = null;

  return (s: BindingStoreSlice) => {
    const relevantChange =
      !cache ||
      s.metadataReceived !== cache.metadataReceived ||
      s.wsConnected !== cache.wsConnected ||
      s.snapshotReceived !== cache.snapshotReceived ||
      depValueIds.some((id) => s.values[id] !== cache!.values[id]) ||
      depIds.some((id) => s.varMeta[id] !== cache!.varMeta[id]) ||
      depDatasources.some((ds) => s.opcuaConnected[ds] !== cache!.opcuaConnected[ds]);

    if (!relevantChange) return cache!.result;

    onRecompute?.();
    const result = aggregateBindingStatus(bindingSpecs, s);
    cache = {
      values: s.values,
      varMeta: s.varMeta,
      metadataReceived: s.metadataReceived,
      wsConnected: s.wsConnected,
      snapshotReceived: s.snapshotReceived,
      opcuaConnected: s.opcuaConnected,
      result,
    };
    return result;
  };
}

/**
 * React hook — subscribes to the variable store and returns the aggregate
 * binding status ('ok' | 'disabled' | 'disconnected') for a set of
 * BindingSpecs. Used by ComponentRenderer.
 */
export function useBindingStatus(
  properties: Record<string, unknown> | undefined,
  schema: Record<string, { type: string | string[]; requiredFields?: RequiredFieldEntry[] }>,
): 'ok' | 'disabled' | 'disconnected' {
  const bindingSpecs = useMemo(() => extractBindingSpecs(properties, schema), [properties, schema]);
  const selector = useMemo(() => createBindingStatusSelector(bindingSpecs), [bindingSpecs]);
  return useVariableStore(selector);
}

// ── Struct default value helper ──────────────────────────────────────────────

const EMPTY_VAR = { $var: { path: '' } } as const;

/**
 * Normalise a struct field value: if it already has a `$var` wrapper return it
 * as-is, otherwise return the empty default.
 */
export function structVarDefault(value: unknown): unknown {
  if (value && typeof value === 'object' && '$var' in (value as Record<string, unknown>)) {
    return value;
  }
  return EMPTY_VAR;
}
