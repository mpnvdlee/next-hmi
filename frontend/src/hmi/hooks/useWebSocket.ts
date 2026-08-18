/**
 * WebSocket singleton + hook.
 *
 * One WebSocket connection per browser tab, kept alive for the entire app
 * lifetime (hook is called in App.tsx). Auto-reconnects with exponential
 * backoff (500 ms → 1 s → 2 s → 4 s → 8 s → 10 s max).
 *
 * Message dispatch:
 *   var_snapshot  → sets ALL scalars / structs in variableStore (initial sync)
 *   var_update    → merges changed scalars / structs into variableStore
 *
 * To send a message from anywhere in the app, import and call sendWsMessage().
 */

import { useEffect, useRef } from 'react';
import { useVariableStore, type VarMeta } from '../store/variableStore';
import { useHmiStore } from '../store/hmiStore';
import { useAlarmStore } from '../store/alarmStore';
import { useRecipeStore } from '../store/recipeStore';
import { publishConfigChanged } from '@shared/events/configChangedBus';
import { publishWidgetUpdated } from '@shared/events/widgetUpdatedBus';
import type { AlarmInstance, AlarmSummary } from '@shared/types/alarm';
import type { RecipeConfig, LoadedDataset, DownloadResult } from '@shared/types/recipe';
import type { ActionResultReason } from '@shared/types/config';
import { flushAllAsDisconnected, resolvePending } from '../utils/actionDispatcher';
import { wsUrl } from '@shared/utils/runtimeBase';

// ── Inbound message schema ────────────────────────────────────────────────────
// Discriminated union of every message the backend can send. The handler below
// narrows on `type`; adding a new server-side message means adding a variant
// here so the switch loses exhaustiveness if not handled.

type WsMessage =
  | { type: 'var_snapshot'; values?: Record<string, unknown> }
  | { type: 'var_update'; values?: Record<string, unknown> }
  | { type: 'var_removed'; ids?: string[] }
  | { type: 'var_metadata'; meta?: Record<string, VarMeta> }
  | { type: 'context_ready'; currentPageIds?: string[] }
  | { type: 'opcua_status'; datasource: string; connected: boolean }
  | {
      type: 'user_identity';
      scope: string;
      username: string;
      groups?: string[];
      groupLabels?: Record<string, string>;
      /** Echoed by the backend only when this is a login/logout response. */
      requestId?: string;
    }
  | { type: 'auth_error'; scope: string; reason: ActionResultReason; requestId?: string }
  | {
      type: 'write_response';
      requestId: string;
      datasource: string;
      path: string;
    }
  | {
      type: 'write_error';
      requestId: string;
      datasource: string;
      path: string;
      reason: ActionResultReason;
    }
  | { type: 'alarm_snapshot'; active?: AlarmInstance[]; summary?: AlarmSummary }
  | { type: 'alarm_update'; active?: AlarmInstance[]; summary?: AlarmSummary }
  | {
      type: 'recipe_snapshot' | 'recipe_update';
      config?: RecipeConfig;
      loaded?: Record<string, LoadedDataset>;
      lastResult?: DownloadResult | null;
    }
  | {
      type: 'recipe_response';
      requestId: string;
      result: DownloadResult | { datasetId: string } | null;
    }
  | { type: 'recipe_error'; requestId: string; reason: string }
  | {
      type: 'config_changed';
      artifact_type:
        'page' | 'datasource' | 'alarms' | 'translations' | 'asset' | 'variables' | 'component';
      artifact_ids: string[];
      source: 'mcp' | 'rest';
      agent_label?: string;
      summary: string;
      diff?: unknown;
    }
  | {
      type: 'widget_updated';
      /** Canonical normalized path relative to custom-widgets/. */
      key: string;
      name: string;
      ts: string;
      schema_ok: boolean;
    }
  | { type: 'restarting'; reason?: string };

function parseWsMessage(raw: string): WsMessage | null {
  try {
    const parsed = JSON.parse(raw) as { type?: unknown };
    if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
      return parsed as WsMessage;
    }
  } catch {
    // ignore malformed frames
  }
  return null;
}

// ── Module-level singleton ────────────────────────────────────────────────────
// Using a module-level variable means exactly one WS regardless of how many
// times the hook is rendered (e.g. React StrictMode double-invoke).
let _ws: WebSocket | null = null;

// Coalesce var_snapshot / var_update payloads into one render per animation
// frame. Without this, a tab that has been backgrounded for a while drains
// hundreds of buffered WS frames on resume; each one would call applyBatch
// (one Zustand set → one React render pass), saturating the main thread for
// seconds. RAF is paused while the tab is hidden, so the buffer naturally
// holds until the tab becomes visible, then flushes once with last-write-wins
// per variable id.
let _pendingValues: Record<string, unknown> | null = null;
let _pendingSnapshot = false;
// Latest context_ready payload, held until the same flush as the var_update(s)
// that satisfy it — context_ready always arrives on the wire after its
// corresponding values (see backend _handle_set_context), so queuing it
// through this same buffer guarantees the store's scalars/structs are already
// updated by the time a consumer sees contextReadyPageIds include a page.
let _pendingContextReady: string[] | null = null;
// Normalized page-set of the most recent set_context we actually sent. Used to
// drop stale context_ready acks: a superseded navigation's background OPC-UA
// prefetch can land after we've already moved on, and applying its ack would
// drop the current page from contextReadyPageIds and flash it back to its
// spinner. The backend echoes currentPageIds verbatim, so matching on them
// identifies the ack's originating set_context without a wire-level token.
let _lastSentContextKey: string | null = null;
let _flushRaf: number | null = null;
let _flushFns: {
  applyBatch: { current: (updates: Record<string, unknown>) => void };
  replaceValues: { current: (values: Record<string, unknown>) => void };
  markSnapshotReceived: { current: () => void };
  setContextReady: { current: (pageIds: string[]) => void };
} | null = null;

function flushPendingVarUpdates(): void {
  _flushRaf = null;
  const values = _pendingValues;
  const wasSnapshot = _pendingSnapshot;
  const contextReady = _pendingContextReady;
  _pendingValues = null;
  _pendingSnapshot = false;
  _pendingContextReady = null;
  if (!_flushFns) return;
  if (values) {
    if (wasSnapshot) _flushFns.replaceValues.current(values);
    else _flushFns.applyBatch.current(values);
  }
  if (wasSnapshot) _flushFns.markSnapshotReceived.current();
  if (contextReady) _flushFns.setContextReady.current(contextReady);
}

function enqueueVarUpdate(
  type: 'var_snapshot' | 'var_update',
  values: Record<string, unknown> | undefined,
): void {
  if (type === 'var_snapshot') {
    // A snapshot starts a new authoritative value generation. Drop any queued
    // updates from the previous socket; later chunks merge into this object.
    _pendingValues = { ...(values ?? {}) };
    _pendingSnapshot = true;
  } else if (values) {
    if (!_pendingValues) _pendingValues = {};
    Object.assign(_pendingValues, values);
  }
  if (_flushRaf === null) {
    _flushRaf = requestAnimationFrame(flushPendingVarUpdates);
  }
}

/** Order-independent key of a set_context / context_ready page-set. */
function contextPageKey(ids: unknown): string {
  if (!Array.isArray(ids)) return '';
  return ids
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .sort()
    .join('\n');
}

function enqueueContextReady(currentPageIds: string[]): void {
  _pendingContextReady = currentPageIds;
  if (_flushRaf === null) {
    _flushRaf = requestAnimationFrame(flushPendingVarUpdates);
  }
}

type ConfigChangedMsg = Extract<WsMessage, { type: 'config_changed' }>;

function ingestConfigChanged(msg: ConfigChangedMsg): void {
  publishConfigChanged({
    artifact_type: msg.artifact_type,
    artifact_ids: msg.artifact_ids,
    source: msg.source,
    agent_label: msg.agent_label,
    summary: msg.summary,
    diff: msg.diff,
  });
}

/** Send any JSON-serialisable message. Safe to call before the socket opens. */
export function sendWsMessage(msg: unknown): void {
  if (_ws?.readyState === WebSocket.OPEN) {
    if (
      typeof msg === 'object' &&
      msg !== null &&
      (msg as { type?: unknown }).type === 'set_context'
    ) {
      _lastSentContextKey = contextPageKey((msg as { currentPageIds?: unknown }).currentPageIds);
    }
    _ws.send(JSON.stringify(msg));
  }
}

// ── Hook ─────────────────────────────────────────────────────────────────────
/**
 * Call once at the top of the component tree (App.tsx).
 * Sets up the WebSocket connection and reconnect loop.
 */
export function useWebSocket(): void {
  const applyBatch = useVariableStore((s) => s.applyBatch);
  const replaceValues = useVariableStore((s) => s.replaceValues);
  const markSnapshotReceived = useVariableStore((s) => s.markSnapshotReceived);
  const setContextReady = useVariableStore((s) => s.setContextReady);
  const removeVars = useVariableStore((s) => s.removeVars);
  const setWsConnected = useVariableStore((s) => s.setWsConnected);
  const setOpcuaConnected = useVariableStore((s) => s.setOpcuaConnected);
  const clearOpcuaConnected = useVariableStore((s) => s.clearOpcuaConnected);
  const setVarMeta = useVariableStore((s) => s.setVarMeta);

  // Keep stable refs to the latest store actions so WS callbacks never go stale
  const applyBatchRef = useRef(applyBatch);
  const replaceValuesRef = useRef(replaceValues);
  const markSnapshotReceivedRef = useRef(markSnapshotReceived);
  const setContextReadyRef = useRef(setContextReady);
  const removeVarsRef = useRef(removeVars);
  const setWsConnectedRef = useRef(setWsConnected);
  const setOpcuaConnectedRef = useRef(setOpcuaConnected);
  const clearOpcuaConnectedRef = useRef(clearOpcuaConnected);
  const setVarMetaRef = useRef(setVarMeta);
  applyBatchRef.current = applyBatch;
  replaceValuesRef.current = replaceValues;
  markSnapshotReceivedRef.current = markSnapshotReceived;
  setContextReadyRef.current = setContextReady;
  removeVarsRef.current = removeVars;
  setWsConnectedRef.current = setWsConnected;
  setOpcuaConnectedRef.current = setOpcuaConnected;
  clearOpcuaConnectedRef.current = clearOpcuaConnected;
  setVarMetaRef.current = setVarMeta;

  // hmiStore identity refs — access via getState() to avoid re-subscribing
  const setCurrentUserRef = useRef(useHmiStore.getState().setCurrentUser);
  const setLoginErrorRef = useRef(useHmiStore.getState().setLoginError);
  const setAlarmStateRef = useRef(useAlarmStore.getState().setAlarmState);
  const setRecipeSnapshotRef = useRef(useRecipeStore.getState().setSnapshot);

  useEffect(() => {
    let destroyed = false;
    let backoff = 500;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    // Wire the RAF flusher to the latest store actions. Refs are stable objects
    // that the hook keeps pointing at the current store functions, so the
    // module-level flusher always sees up-to-date callbacks.
    _flushFns = {
      applyBatch: applyBatchRef,
      replaceValues: replaceValuesRef,
      markSnapshotReceived: markSnapshotReceivedRef,
      setContextReady: setContextReadyRef,
    };

    function scheduleReconnect(): void {
      if (destroyed) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!destroyed) connect();
      }, backoff);
      backoff = Math.min(backoff * 2, 10_000);
    }

    function connect(): void {
      // If a usable connection already exists from a previous render (StrictMode),
      // keep it and just wire the handlers below.
      if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) {
        return;
      }
      // A CLOSING socket from the StrictMode cleanup is still draining — null it
      // so the new socket below doesn't race against it.
      if (_ws && _ws.readyState === WebSocket.CLOSING) {
        _ws = null;
      }

      const ws = new WebSocket(wsUrl());
      _ws = ws;

      ws.onopen = () => {
        backoff = 500; // reset backoff on successful connect
        setWsConnectedRef.current(true);
      };

      ws.onmessage = (event: MessageEvent) => {
        const msg = parseWsMessage(event.data as string);
        if (!msg) return;

        switch (msg.type) {
          case 'var_snapshot':
          case 'var_update':
            enqueueVarUpdate(msg.type, msg.values);
            return;
          case 'var_removed':
            if (Array.isArray(msg.ids)) removeVarsRef.current(msg.ids);
            return;
          case 'var_metadata':
            if (msg.meta && typeof msg.meta === 'object') setVarMetaRef.current(msg.meta);
            return;
          case 'context_ready': {
            const readyPageIds = Array.isArray(msg.currentPageIds) ? msg.currentPageIds : [];
            // Drop acks from a superseded set_context (see _lastSentContextKey)
            // so a late prefetch can't flash the current page back to a spinner.
            if (contextPageKey(readyPageIds) === _lastSentContextKey) {
              enqueueContextReady(readyPageIds);
            }
            return;
          }
          case 'opcua_status':
            setOpcuaConnectedRef.current(msg.datasource, msg.connected);
            return;
          case 'user_identity':
            if (msg.scope) {
              setCurrentUserRef.current(msg.scope, {
                username: msg.username,
                groups: msg.groups ?? [],
                groupLabels: msg.groupLabels ?? {},
              });
              setLoginErrorRef.current(msg.scope, null);
            }
            // requestId is present only on responses to login/logout (never
            // for auto-login via request_identity), so this resolve cannot
            // confuse the dispatcher.
            if (msg.requestId) {
              resolvePending(
                msg.requestId,
                {
                  username: msg.username,
                  groups: msg.groups ?? [],
                  groupLabels: msg.groupLabels ?? {},
                },
                true,
              );
            }
            return;
          case 'auth_error':
            if (msg.scope) setLoginErrorRef.current(msg.scope, msg.reason ?? 'error');
            if (msg.requestId) {
              resolvePending(msg.requestId, { reason: msg.reason ?? 'error' }, false);
            }
            return;
          case 'write_response':
            resolvePending(msg.requestId, { datasource: msg.datasource, path: msg.path }, true);
            return;
          case 'write_error':
            resolvePending(
              msg.requestId,
              { datasource: msg.datasource, path: msg.path, reason: msg.reason },
              false,
            );
            return;
          case 'alarm_snapshot':
          case 'alarm_update':
            if (msg.active && msg.summary) {
              setAlarmStateRef.current(msg.active, msg.summary);
            }
            return;
          case 'recipe_snapshot':
          case 'recipe_update':
            if (msg.config) {
              setRecipeSnapshotRef.current(msg.config, msg.loaded ?? {}, msg.lastResult ?? null);
            }
            return;
          case 'recipe_response':
            resolvePending(msg.requestId, (msg.result ?? {}) as Record<string, unknown>, true);
            return;
          case 'recipe_error':
            resolvePending(msg.requestId, { reason: msg.reason }, false);
            return;
          case 'config_changed':
            ingestConfigChanged(msg);
            return;
          case 'widget_updated':
            publishWidgetUpdated({
              key: msg.key,
              name: msg.name,
              ts: msg.ts,
              schema_ok: msg.schema_ok,
            });
            return;
          case 'restarting':
            // Surfaced by the projects view via its own poll; nothing else to do.
            return;
        }
      };

      ws.onclose = () => {
        if (_ws === ws) _ws = null; // don't clobber a newer instance
        setWsConnectedRef.current(false);
        clearOpcuaConnectedRef.current(); // backend is unreachable, OPC-UA state unknown
        // Fail any in-flight action requests — backend responses can no longer
        // arrive on this socket, so authored onFailed/onSettled handlers fire
        // with reason: 'disconnected' instead of hanging until 10s timeout.
        flushAllAsDisconnected();
        if (!destroyed) scheduleReconnect();
      };

      ws.onerror = () => {
        ws.close(); // triggers onclose → scheduleReconnect
      };
    }

    connect();

    return () => {
      destroyed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (_flushRaf !== null) {
        cancelAnimationFrame(_flushRaf);
        _flushRaf = null;
      }
      _pendingValues = null;
      _pendingSnapshot = false;
      _pendingContextReady = null;
      _flushFns = null;
      if (_ws) {
        const closing = _ws;
        _ws = null;
        closing.close();
      }
      // Belt-and-braces against environments where close() doesn't fire
      // onclose synchronously (tests, HMR) — onclose calls flushAll too,
      // and a second call is a no-op on an empty Map.
      flushAllAsDisconnected();
    };
  }, []); // run once per app mount
}
