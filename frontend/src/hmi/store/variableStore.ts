import { create } from 'zustand';
import type { VarType } from '@shared/types/varType';
import { isRecord } from '@shared/types/propertyValueGuards';

/** Variable shape metadata sent by the backend at connection time. */
export interface VarMeta {
  /** Canonical type — array-ness, base/struct-name, and fields all live here. */
  type: VarType;
  /** Configured numeric range — scalar variables only. */
  min?: number;
  max?: number;
  /** Whether the variable accepts writes — scalar variables only. */
  writable?: boolean;
  /** Configured numeric range per field — structs only. */
  fieldRanges?: Record<string, { min?: number; max?: number }>;
  /** An element of a struct array only — its index in the array, from 0
   *  whatever index the PLC starts at. */
  position?: number;
}

/**
 * Datasource of a Value input's local slot (`useValueInputs`). It lives in this
 * store so every reader, writer and subscription treats it as a variable, but
 * it is this browser's own state: the backend never sees it, so nothing a
 * connection or metadata frame replaces may drop it.
 */
export const LOCAL_INPUT_DATASOURCE = '$input';
const LOCAL_INPUT_PREFIX = `${LOCAL_INPUT_DATASOURCE}:`;

/** The store key of one Value input slot of one mounted frame. */
export function localInputKey(frame: string, slot: string): string {
  return `${LOCAL_INPUT_PREFIX}${frame}/${slot}`;
}

export function isLocalInputKey(key: string): boolean {
  return key.startsWith(LOCAL_INPUT_PREFIX);
}

/** `next` with the local input slots of `prev` carried over. */
function keepLocalInputs(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...next };
  for (const key of Object.keys(prev)) if (isLocalInputKey(key)) out[key] = prev[key];
  return out;
}

/**
 * `next`, with every part that deep-equals the same part of `prev` swapped for
 * `prev`'s own object — `prev` itself when the two are equal throughout. A
 * frame arrives as fresh JSON, so without this every object in it is new and
 * every selector holding one sees a change.
 */
function shareEqual<T>(prev: unknown, next: T): T {
  if (Object.is(prev, next)) return prev as T;
  if (Array.isArray(prev) && Array.isArray(next)) {
    let equal = prev.length === next.length;
    let out: unknown[] | undefined;
    for (let i = 0; i < next.length; i++) {
      const part = shareEqual(prev[i], next[i]);
      if (part !== prev[i]) equal = false;
      if (part !== next[i]) (out ??= next.slice())[i] = part;
    }
    return (equal ? prev : (out ?? next)) as T;
  }
  if (isRecord(prev) && isRecord(next)) {
    const keys = Object.keys(next);
    let equal = keys.length === Object.keys(prev).length;
    let out: Record<string, unknown> | undefined;
    for (const key of keys) {
      const part = shareEqual(prev[key], next[key]);
      if (part !== prev[key] || !(key in prev)) equal = false;
      if (part !== next[key]) (out ??= { ...next })[key] = part;
    }
    return (equal ? prev : (out ?? next)) as T;
  }
  return next;
}

interface VariableStore {
  /**
   * Live variable values: composite key ("datasource:path") → value (scalar,
   * scalar array, struct field map, or struct[] array). Shape is never
   * inferred from a value here — consult `varMeta[id].type`, the
   * authoritative source (see `checkBindingSpec` in `bindingValidation.ts`).
   */
  values: Record<string, unknown>;
  /** Variable shape metadata from datasource config — available before live data arrives */
  varMeta: Record<string, VarMeta>;
  /** The metadata frame `varMeta` replaced: with it, the frames whose keys'
   *  values `setVarMeta` keeps. */
  prevVarMeta: Record<string, VarMeta>;
  /** True after the authoritative var_metadata frame (including an empty one). */
  metadataReceived: boolean;
  /**
   * Whether `varMeta` answers the latest `set_context` sent — its frame echoed
   * that context's id. A page in the context can then judge its bindings on it
   * without waiting for the context's `context_ready`.
   */
  metaCurrent: boolean;
  /** True once the first var_snapshot has been received from the server */
  snapshotReceived: boolean;
  /**
   * `currentPageIds` from the most recent backend `context_ready` ack — every
   * variable requested by that `set_context` (cached and/or freshly read) has
   * been sent. Unlike `snapshotReceived` (a connection-lifetime one-shot flag)
   * this reflects a specific navigation, so a page whose id isn't in the list
   * yet genuinely hasn't had its own data delivered.
   */
  contextReadyPageIds: string[];
  /** True while the WebSocket connection to the backend is open */
  wsConnected: boolean;
  /** Per-datasource OPC-UA connection state. Key = datasource name, value = connected. */
  opcuaConnected: Record<string, boolean>;

  setScalar(id: string, value: unknown): void;
  /**
   * Apply a batch of variable updates in a single Zustand set() call.
   * Far cheaper than calling setScalar once per variable when
   * processing a var_update message with many entries.
   */
  applyBatch(updates: Record<string, unknown>): void;
  /** Replace the complete value generation when a new WS snapshot starts. */
  replaceValues(values: Record<string, unknown>): void;
  markSnapshotReceived(): void;
  setContextReady(currentPageIds: string[]): void;
  /** Remove one or more variable IDs from the store (variable disabled on server) */
  removeVars(ids: string[]): void;
  setWsConnected(v: boolean): void;
  setOpcuaConnected(datasource: string, v: boolean): void;
  clearOpcuaConnected(): void;
  /** `current`: whether the frame answers the latest context (`metaCurrent`);
   *  undefined leaves that as it was. */
  setVarMeta(meta: Record<string, VarMeta>, current?: boolean): void;
  setMetaCurrent(current: boolean): void;
}

export const useVariableStore = create<VariableStore>((set) => ({
  values: {},
  varMeta: {},
  prevVarMeta: {},
  metadataReceived: false,
  metaCurrent: false,
  snapshotReceived: false,
  contextReadyPageIds: [],
  wsConnected: false,
  opcuaConnected: {},

  setScalar: (id, value) => set((state) => ({ values: { ...state.values, [id]: value } })),

  // A composite comes whole around each changed leaf — a struct array re-sent
  // for one element's field. Its unchanged parts keep their objects, so the
  // Repeater copy of an unchanged element, or any other reader of one, sees
  // no change.
  // A batch that changes nothing — identical frames resent — keeps the state,
  // so no subscriber runs.
  applyBatch: (updates) =>
    set((state) => {
      let values: Record<string, unknown> | undefined;
      for (const [key, value] of Object.entries(updates)) {
        const previous = state.values[key];
        const next = shareEqual(previous, value);
        if (next === previous && key in state.values) continue;
        (values ??= { ...state.values })[key] = next;
      }
      return values ? { values } : state;
    }),

  replaceValues: (values) => set((state) => ({ values: keepLocalInputs(state.values, values) })),

  markSnapshotReceived: () => set({ snapshotReceived: true }),

  setContextReady: (currentPageIds) => set({ contextReadyPageIds: currentPageIds }),

  removeVars: (ids) =>
    set((state) => {
      // Nothing to drop keeps the state, so no subscriber runs: an unmounting
      // Value input often finds its slots already gone.
      if (!ids.some((id) => id in state.values || id in state.varMeta || id in state.prevVarMeta)) {
        return state;
      }
      const values = { ...state.values };
      const varMeta = { ...state.varMeta };
      const prevVarMeta = { ...state.prevVarMeta };
      for (const id of ids) {
        delete values[id];
        delete varMeta[id];
        delete prevVarMeta[id];
      }
      return { values, varMeta, prevVarMeta };
    }),

  setWsConnected: (v) =>
    set((state) =>
      v
        ? {
            values: keepLocalInputs(state.values, {}),
            varMeta: {},
            prevVarMeta: {},
            metadataReceived: false,
            metaCurrent: false,
            wsConnected: true,
            snapshotReceived: false,
            contextReadyPageIds: [],
            opcuaConnected: {},
          }
        : { wsConnected: false, contextReadyPageIds: [] },
    ),

  setOpcuaConnected: (datasource, v) =>
    set((state) => ({ opcuaConnected: { ...state.opcuaConnected, [datasource]: v } })),

  clearOpcuaConnected: () => set({ opcuaConnected: {} }),

  setMetaCurrent: (current) => set({ metaCurrent: current }),

  // Metadata is per context, so it replaces wholesale but values are kept: a
  // key outside the new context is only off screen, and its last value is what
  // the page shows when navigated back to, until the fresh read lands. A deleted
  // variable goes by `var_removed`; one that missed it has no metadata, so its
  // binding is still marked once the page settles.
  //
  // Only the keys of the last three metadata frames keep their values, though:
  // kept for every frame, `values` grows with each page ever opened, and
  // `applyBatch` copies all of it on every flush. Frames, not pages: a
  // datasource edit, a page's component definitions loading and a variable-table
  // scroll each send one on the same page.
  //
  // An entry the frame repeats unchanged keeps its object, and a frame that
  // repeats them all keeps the map: a widget reading one variable's metadata
  // must not re-render because an overlay or a table scroll sent a frame.
  setVarMeta: (next, current) =>
    set((state) => {
      const meta = shareEqual(state.varMeta, next);
      const frames = [meta, state.varMeta, state.prevVarMeta];
      const values: Record<string, unknown> = {};
      let dropped = false;
      for (const [key, value] of Object.entries(state.values)) {
        if (isLocalInputKey(key) || frames.some((m) => key in m)) values[key] = value;
        else dropped = true;
      }
      return {
        varMeta: meta,
        prevVarMeta: state.varMeta,
        metadataReceived: true,
        metaCurrent: current ?? state.metaCurrent,
        // Unchanged, the map keeps its identity: no subscriber re-renders for nothing.
        values: dropped ? values : state.values,
      };
    }),
}));
