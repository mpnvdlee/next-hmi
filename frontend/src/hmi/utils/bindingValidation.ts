/**
 * Shared binding-validation utilities used by both the runtime overlay
 * (ComponentRenderer) and the editor properties panel (PropertiesPanel).
 *
 * The single source of truth for "is this variable binding compatible with
 * this schema field?" lives here, so the editor's ! indicator and the HMI's
 * red-cross overlay always agree.
 *
 * The overlay variants split by cause: red for a binding that is *wrong*
 * (unknown variable, incompatible type) and amber for one that is merely
 * without data (datasource down, or a value that never arrived). Only the red
 * one is a config error; the amber ones resolve themselves when data lands.
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
 * A property whose whole value is a `$var` is checked against its schema slot's
 * type. Every *other* variable the widget puts on screen — one nested inside a
 * `$stringExpr` template, a `$compare` operand — is checked for presence only:
 * it has no slot of its own, so there is no declared type to validate against,
 * but a widget showing a variable that is dead or missing still has to say so.
 * Missing them is what let a KPI whose value came from a `$stringExpr` wildcard
 * keep rendering its last number with no mark at all.
 *
 * "On screen" is the limit, and `extractRenderedVarKeys` is where it is drawn:
 * a variable that only appears in an action payload, in a `visible` condition,
 * or in the branch of an `$if`/`$switch` that lost decides nothing the viewer
 * can see, and marking the widget for it would be a mark with no referent.
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
 *  runs on press, and a visibility gate decides whether the widget renders
 *  rather than what it shows — a missing value in either is not something the
 *  viewer is looking at.
 *
 *  The gate keys come from the pinned universal-property list rather than being
 *  spelled out here: a third gate property added to the schema would otherwise
 *  start marking widgets that render correctly, and nothing would catch it.
 *
 *  A key the schema does not declare is not treated as rendered either. There
 *  is no way to tell what such a property does — and the case is not rare:
 *  `registerCustomWidget` falls back to a schema of just the visibility gates
 *  when the compiler could not read a widget's exports (`schemaError`), so
 *  every property on that widget lands here, `actions` included, and a press
 *  handler writing to a never-published variable would mark a widget that
 *  renders and works. Post-rename leftovers on a node hit the same path. */
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
 * Used by WidgetRenderer to decide whether to show the overlay and which variant.
 */
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

  // The variable exists and the binding is sound — no value has arrived for it.
  // Not a config error, so never the red cross: amber, and only once the
  // surrounding DataSettleGate says the load is over (see `useBindingStatus`),
  // so a value still in flight is waited for rather than marked.
  return 'nodata';
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
 * React hook — subscribes to the variable store and returns the aggregate
 * binding status for a set of BindingSpecs. Used by WidgetRenderer.
 *
 * While the surrounding surface is still settling (`DataSettleGate`), a
 * 'nodata' answer is held at 'ok': a page reveals without waiting for its
 * variables, so every binding on it is momentarily valueless and marking there
 * would flash a mark over the whole page for the length of one OPC-UA read.
 * 'disabled' and 'disconnected' are not held — neither is a matter of timing.
 * The selector still runs, so the moment the window closes the mark is the live
 * answer, not a stale snapshot of it.
 */
export function useBindingStatus(
  properties: Record<string, unknown> | undefined,
  schema: Record<string, { type: string | string[]; requiredFields?: RequiredFieldEntry[] }>,
): BindingStatus {
  const bindingSpecs = useMemo(() => extractBindingSpecs(properties, schema), [properties, schema]);
  const selector = useMemo(() => createBindingStatusSelector(bindingSpecs), [bindingSpecs]);
  const status = useVariableStore(selector);
  const settling = useDataSettling();
  // Only the "no value yet" answer waits: it is the one the settle window
  // exists for. A wrong binding is wrong whatever the datasource is doing, and
  // a reconnect reopens this window — holding 'disconnected' here would clear
  // every overlay on screen the instant the backend went down, which is the
  // opposite of what that overlay is for.
  return settling && status === 'nodata' ? 'ok' : status;
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
