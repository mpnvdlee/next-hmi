import { create } from 'zustand';
import type { VarType } from '@shared/types/varType';

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

  applyBatch: (updates) =>
    set((state) => {
      if (Object.keys(updates).length === 0) return state;
      return { values: { ...state.values, ...updates } };
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
  setVarMeta: (next, current) =>
    set((state) => {
      const meta = next;
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
