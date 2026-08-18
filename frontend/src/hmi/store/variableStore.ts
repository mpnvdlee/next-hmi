import { create } from 'zustand';
import type { VarType } from '@shared/types/varType';

/** Variable shape metadata sent by the backend at connection time. */
export interface VarMeta {
  /** Canonical type — array-ness, base/struct-name, and fields all live here. */
  type: VarType;
  /** Configured numeric range — scalar variables only. */
  min?: number;
  max?: number;
  /** Configured numeric range per field — structs only. */
  fieldRanges?: Record<string, { min?: number; max?: number }>;
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
  /** True after the authoritative var_metadata frame (including an empty one). */
  metadataReceived: boolean;
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
  setVarMeta(meta: Record<string, VarMeta>): void;
}

export const useVariableStore = create<VariableStore>((set) => ({
  values: {},
  varMeta: {},
  metadataReceived: false,
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

  replaceValues: (values) => set({ values: { ...values } }),

  markSnapshotReceived: () => set({ snapshotReceived: true }),

  setContextReady: (currentPageIds) => set({ contextReadyPageIds: currentPageIds }),

  removeVars: (ids) =>
    set((state) => {
      const values = { ...state.values };
      const varMeta = { ...state.varMeta };
      for (const id of ids) delete values[id];
      for (const id of ids) delete varMeta[id];
      return { values, varMeta };
    }),

  setWsConnected: (v) =>
    set(
      v
        ? {
            values: {},
            varMeta: {},
            metadataReceived: false,
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

  setVarMeta: (meta) =>
    set((state) => {
      // Metadata snapshots are authoritative. Prune values for removed keys so
      // a missed var_removed frame cannot keep a deleted binding alive.
      const values: Record<string, unknown> = {};
      for (const key of Object.keys(meta)) {
        if (key in state.values) values[key] = state.values[key];
      }
      return { varMeta: meta, values, metadataReceived: true };
    }),
}));
