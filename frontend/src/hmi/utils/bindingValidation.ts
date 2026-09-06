/**
 * "Is this variable binding compatible with this schema field?" — one answer for
 * both the runtime overlay (ComponentRenderer) and the editor panel, so the
 * editor's ! indicator and the HMI's red cross always agree.
 *
 * The variants split by cause: red for a binding that is *wrong* (unknown
 * variable, incompatible type), amber for one merely without data (datasource
 * down, value never arrived). Only red is a config error.
 */

import { getPropBinding } from '../components/layoutUtils';
import { extractRenderedVarKeys } from './extractVarKeys';
import { isVisibilityGateProperty } from '@shared/types/universalWidgetProperties';
import { bindingKey } from '@shared/types/config';
import type { RequiredFieldEntry } from '@shared/types/widgetSchema';
import { accepts, elementOf, parseTypeToken, type AcceptType } from '@shared/types/varType';
import { acceptedValueTypes } from '@shared/utils/valueTypes';
import { useVariableStore } from '../store/variableStore';
import type { VarMeta } from '../store/variableStore';
import { useDataSettling } from '../context/DataSettleContext';
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
}

/** Overlay a widget wears, worst-first: a wrong binding, a dead datasource, a
 *  binding that simply has no value, or nothing at all. */
export type BindingStatus = 'ok' | 'disabled' | 'disconnected' | 'nodata';

// ── Extraction ───────────────────────────────────────────────────────────────

/**
 * Convert a component's property map + schema into per-field BindingSpecs.
 *
 * A property whose whole value is a `$var` is type-checked against its schema
 * slot. Every *other* variable the widget puts on screen — nested in a
 * `$stringExpr` template, a `$compare` operand — is checked for presence only:
 * it has no slot, so no declared type, but a widget showing a dead variable
 * still has to say so.
 *
 * "On screen" is the limit, drawn by `extractRenderedVarKeys`: a variable that
 * only appears in an action payload, a `visible` condition, or a losing
 * `$if`/`$switch` branch would be a mark with no referent.
 */
export function extractBindingSpecs(
  properties: Record<string, unknown> | undefined,
  schema: Record<string, { type: string | string[]; requiredFields?: RequiredFieldEntry[] }>,
): BindingSpec[] {
  if (!properties) return [];
  const specs: BindingSpec[] = [];
  const covered = new Set<string>();
  const nested = new Set<string>();
  for (const key of Object.keys(properties)) {
    const field = schema[key];
    const b = getPropBinding(properties, key);
    const id = b ? bindingKey(b) : '';
    if (b && id) {
      covered.add(id);
      specs.push({
        id,
        index: b.index,
        accept: acceptTypes(field?.type),
        requiredFields: field?.requiredFields,
      });
    }
    if (!isRenderedProperty(key, field)) continue;
    for (const nestedId of extractRenderedVarKeys(properties[key])) nested.add(nestedId);
  }
  for (const id of nested) {
    if (covered.has(id)) continue;
    specs.push({ id, accept: [] });
  }
  return specs;
}

/** Whether a property's variables reach the screen at all. An `actions` payload
 *  runs on press and a visibility gate decides whether the widget renders, so
 *  neither is something the viewer is looking at. The gate keys come from the
 *  pinned universal-property list so a third one added to the schema does not
 *  silently start marking healthy widgets.
 *
 *  A key the schema does not declare is not rendered either: `registerCustomWidget`
 *  falls back to a gates-only schema when the compiler could not read a widget's
 *  exports (`schemaError`), so every property on that widget lands here —
 *  `actions` included — as do post-rename leftovers on a node. */
function isRenderedProperty(key: string, field?: { type: string | string[] }): boolean {
  if (isVisibilityGateProperty(key)) return false;
  if (field === undefined) return false;
  const type = Array.isArray(field.type) ? field.type[0] : field.type;
  return type !== 'actions';
}

// ── Per-binding check ─────────────────────────────────────────────────────────

/**
 * Validate a single binding against store state.
 *
 * Shape and type come from the authoritative `varMeta[id].type`, never from
 * sniffing the live value: an indexed binding resolves to its element type
 * first, so `EventCounters[3]` validates against a scalar `Integer` slot, and a
 * `struct[]` with no elements yet is still valid.
 *
 * `'invalid'` is definitively wrong and raises the red cross; `'pending'` means
 * the binding is sound but no value has arrived.
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

/** Aggregate BindingSpecs into one component-level status — which overlay
 *  variant `WidgetRenderer` shows, if any. */
export function aggregateBindingStatus(
  bindingSpecs: BindingSpec[],
  s: BindingStoreSlice,
): BindingStatus {
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

  // Binding sound, no value yet. Not a config error, so amber — and only once
  // the surrounding DataSettleGate says the load is over (`useBindingStatus`).
  return 'nodata';
}

// ── Component-level binding status hook ──────────────────────────────────────

/**
 * Memoizing selector over `bindingSpecs`: the O(n) recompute runs only when a
 * store update touched something a spec depends on (its value/meta, a referenced
 * datasource's opcua flag, the global ws/snapshot flags). Any other update
 * returns the cached result without scanning at all.
 *
 * `onRecompute` is test instrumentation only.
 */
export function createBindingStatusSelector(
  bindingSpecs: BindingSpec[],
  onRecompute?: () => void,
): (s: BindingStoreSlice) => BindingStatus {
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
    opcuaConnected: Record<string, boolean>;
    result: BindingStatus;
  } | null = null;

  return (s: BindingStoreSlice) => {
    const relevantChange =
      !cache ||
      s.metadataReceived !== cache.metadataReceived ||
      s.wsConnected !== cache.wsConnected ||
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
      opcuaConnected: s.opcuaConnected,
      result,
    };
    return result;
  };
}

/**
 * The aggregate binding status for a widget's specs, as `WidgetRenderer` reads it.
 *
 * While the surface is still settling (`DataSettleGate`), 'nodata' is held at
 * 'ok': a page reveals without waiting for its variables, so marking there would
 * flash a mark over the whole page for one OPC-UA read. The selector still runs,
 * so the answer is live the moment the window closes.
 */
export function useBindingStatus(
  properties: Record<string, unknown> | undefined,
  schema: Record<string, { type: string | string[]; requiredFields?: RequiredFieldEntry[] }>,
): BindingStatus {
  const bindingSpecs = useMemo(() => extractBindingSpecs(properties, schema), [properties, schema]);
  const selector = useMemo(() => createBindingStatusSelector(bindingSpecs), [bindingSpecs]);
  const status = useVariableStore(selector);
  const settling = useDataSettling();
  // Only "no value yet" waits. A wrong binding is wrong whatever the datasource
  // is doing, and a reconnect reopens this window — holding 'disconnected' would
  // clear every overlay the instant the backend went down.
  return settling && status === 'nodata' ? 'ok' : status;
}

// ── Struct default value helper ──────────────────────────────────────────────

const EMPTY_VAR = { $var: { path: '' } } as const;

/** A struct field value with its `$var` wrapper, or the empty default. */
export function structVarDefault(value: unknown): unknown {
  if (value && typeof value === 'object' && '$var' in (value as Record<string, unknown>)) {
    return value;
  }
  return EMPTY_VAR;
}
