# NEXT HMI WebSocket Protocol

Back to architecture hub: [overview.md](overview.md).

This is the single source of truth for the live `/ws` protocol — the handshake,
every server→client and client→server message, and the request/response
correlation used by async actions. `backend/models/websocket.py` carries
TypedDicts for *some* of these — the var/context/auth/write families; the
recipe, alarm, metadata and lifecycle messages are built as plain dicts at the
send site, so this document is the only complete description. The
broadcast/batching machinery is in `backend/services/websocket_manager.py`.

A **project instance** (`backend/main.py`) owns `/ws`. Each browser tab opens one
socket and keeps it alive for the app's lifetime. Through the manager front door
the socket is reached at `/runtime/<slug>/ws` or `/editor/<slug>/ws`, which the
manager proxies to the child's `/ws` (the manager session cookie authorizes the
upgrade). A directly-run instance binds `127.0.0.1` and is unauthenticated.

Inbound frames are capped at **64 KiB**; oversized or non-JSON frames are logged
and dropped. Unknown client `type` values are ignored. Composite keys use the
form `"<datasource>:<path>"` (`models/datasource.py:build_var_key`).

## Handshake

On accept, the backend sends, in order:

1. `var_snapshot` — empty initial marker so the client can mark
   `snapshotReceived` immediately:

   ```json
   { "type": "var_snapshot", "values": {} }
   ```

2. `var_metadata` — shape metadata keyed by composite key. Sent
   **unconditionally**, including as an empty `meta` when no datasource manager
   or variables exist: it is an authoritative *replacement* snapshot, so a
   reconnect must not be able to retain metadata from the previous backend
   generation.

   ```json
   {
     "type": "var_metadata",
     "meta": {
       "MyPLC:Motor1": {
         "kind": "scalar | struct | struct[]",
         "data_type": "boolean | integer | float | string | datetime | <…>[] | <StructName>[]",
         "array_length": 5,
         "fields": ["bValue", "sUnit", "..."]
       }
     }
   }
   ```

3. Chunked `var_update` messages with the full cached value snapshot (500
   entries per chunk, yielding the event loop between chunks).
4. One `opcua_status` per known datasource, replaying the current connection
   state.
5. `alarm_snapshot` — full current alarm state plus summary.
6. `recipe_snapshot` — current recipe config and loaded state.

Steps 3–6 are each skipped when the corresponding manager is absent. If any
send raises, the client is disconnected and the error re-raised rather than
leaving a half-initialised socket registered.

## Server → client messages

| Type | Shape | When |
|---|---|---|
| `var_snapshot` | `{ type, values }` | Once on connect (empty `values`). |
| `var_metadata` | `{ type, meta }` | Once on connect; variable shape metadata. |
| `var_update` | `{ type, values: { [compositeKey]: value } }` | Value changes. Batched in a 50 ms window; the per-datasource priority window is `settings.priority_ws_batch_ms`, clamped to `[0, 1000]`, default 10 ms. |
| `var_removed` | `{ type, ids: [compositeKey, ...] }` | Variables no longer available. |
| `opcua_status` | `{ type, datasource, connected }` | Per-datasource connection-state change. |
| `alarm_snapshot` | `{ type, active: AlarmInstance[], summary: AlarmSummary }` | On connect. |
| `alarm_update` | same shape as `alarm_snapshot`, `type: "alarm_update"` | On fire / clear / ack. |
| `recipe_snapshot` | `{ type, config: RecipeConfig, loaded: { [typeId]: { datasetId, loadedAt } }, lastResult }` | On connect (recipes feature only). |
| `recipe_update` | same shape as `recipe_snapshot`, `type: "recipe_update"` | On config change / download / upload. |
| `recipe_response` | `{ type, requestId, result }` | A correlated `recipe_load` / `recipe_save` succeeded — `result` is the `DownloadResult` (load) or `{ datasetId }` (save). |
| `recipe_error` | `{ type, requestId, reason }` | A correlated `recipe_load` / `recipe_save` failed. |
| `user_identity` | `{ type, scope, username, groups, groupLabels }` | After `login`, `logout`, or `request_identity`. |
| `auth_error` | `{ type, scope, reason }` | Failed `login`. `reason` is currently always `"invalid_credentials"`. |
| `write_response` | `{ type, requestId, datasource, path }` | A correlated `write_field` succeeded — see [Action result correlation](#action-result-correlation). |
| `write_error` | `{ type, requestId, datasource, path, reason }` | A correlated `write_field` failed. |
| `restarting` | `{ type, reason }` | Right before the backend SIGTERMs itself for `POST /api/system/restart`. Clients disconnect and poll `/api/system/info` for the new process. |
| `widget_updated` | `{ type, key, name, ts, schema_ok }` | A custom widget recompiled or was deleted; `key` is its normalized path relative to `custom-widgets/`. |
| `config_changed` | see [config_changed](#config_changed) | After every MCP- or REST-driven config write. |
| `context_ready` | `{ type, currentPageIds: [string, ...] }` | Reply to `set_context`: every variable requested for `currentPageIds` has been sent, from cache and/or a fresh OPC-UA read. Lets the client reveal a newly navigated page once its own data has actually arrived instead of guessing from the connection-lifetime `var_snapshot` flag. The client should ignore any `context_ready` whose page-set doesn't match its most recently sent `set_context` (a superseded navigation's background prefetch can still land late). |

> Auto-login (`request_identity`) never carries a `requestId` in its
> `user_identity`, so the client dispatcher does not confuse it with a `login`
> response.

## Client → server messages

- `set_context` — update active page / dialog context for fast-subscription
  priority and prime the per-client priority set.

  ```json
  {
    "type": "set_context",
    "currentPageIds": ["home"],
    "openDialogIds": ["confirmDialog"],
    "priorityKeys": ["MyPLC:Motor1"]
  }
  ```

  - `currentPageIds` is the only page-context key read. The older
    `currentPageId` (single string) and `openOverlayPageIds` (array) were
    removed, not deprecated — a frame still sending either carries no page
    context and its bindings are never primed.
  - Hard caps: `currentPageIds` ≤ 2000, `openDialogIds` ≤ 2000, `priorityKeys`
    ≤ 5000. Excess entries are dropped silently.
  - The backend resolves bindings from the runtime pages config (walking nested
    `$if` / `$switch` / `$compare` expressions for `$var` references) and updates
    OPC-UA fast subscriptions accordingly.

  Current producers: `HmiView` (active page + dialog context), `PreviewView`
  (preview page/dialog context), `DatasourceVariableTable` (explicit
  `priorityKeys` for visible rows after scroll settle).

- `write_field` — write a value to a variable.

  ```json
  {
    "type": "write_field",
    "datasource": "MyPLC",
    "path": "Motor1/Command",
    "field": "bValue",
    "value": true,
    "scope": "runtime:main",
    "requestId": "8f3c…"
  }
  ```

  - `datasource`, `path`, and `value` are required (`value` must not be `null`).
    `field` selects a struct field; omit it for a scalar.
  - If the path ends with `[N]` the current array is read from cache, element `N`
    is patched, and the full patched array is written.
  - Permission check: if the variable defines `interactableByGroups`, the scoped
    identity's groups must intersect that list.
  - Values are coerced toward the target OPC-UA datatype (boolean, integer with
    range check, float with finite check, string). Boolean strings accept
    `true/false/1/0/on/off/yes/no`; integers reject out-of-range; floats reject
    `NaN`/`inf`.
  - `static` datasources are updated in-process; OPC-UA datasources route through
    the pool engine.
  - `requestId` is optional. When supplied the backend replies with
    `write_response` / `write_error` (see below); when omitted the write is
    fire-and-forget with no response.

- `recipe_load` — download a saved dataset (recipes feature).

  ```json
  { "type": "recipe_load", "datasetId": "espresso", "verify": true, "scope": "runtime:main", "requestId": "…" }
  ```

  - Writes every parameter's stored value via the shared `write_service`
    (continue-on-error). Records the dataset as loaded for its type.
  - Replies `recipe_response` (carrying the `DownloadResult`) or `recipe_error`
    when `requestId` is supplied; fire-and-forget otherwise.

- `recipe_save` — upload live values into a dataset (recipes feature).

  ```json
  { "type": "recipe_save", "datasetId": "espresso", "scope": "runtime:main", "requestId": "…" }
  ```

  - An omitted `datasetId` targets the currently-loaded dataset when exactly one
    type is loaded (otherwise `recipe_error` with `bad_request`). `updatedBy` is
    taken from the scope's identity.

- `login` — authenticate a scope.

  ```json
  { "type": "login", "scope": "runtime:main", "username": "admin", "password": "...", "requestId": "…" }
  ```

  - On match the scope identity is updated and `user_identity` is sent back; on
    mismatch the server sends `auth_error`. Both echo `requestId` when supplied.

- `logout` — revert a scope to `guest`.

  ```json
  { "type": "logout", "scope": "runtime:main", "requestId": "…" }
  ```

  - Sends a `user_identity` with the guest identity (echoing `requestId`).

- `request_identity` — auto-login the configured `settings.autoLoginName` user
  for a scope (falls back to `guest`).

  ```json
  { "type": "request_identity", "scope": "runtime:main" }
  ```

  - Always followed by a `user_identity`; never carries `requestId`.

All `scope` values must be non-empty strings; empty / missing scopes cause the
message to be ignored silently.

## Action result correlation

Client-fired async actions (`login`, `logout`, `write_field`, `recipe_load`,
`recipe_save`) accept an optional `requestId` (UUID). When supplied, the backend
echoes it on the corresponding response so the frontend dispatcher
(`frontend/src/hmi/utils/actionDispatcher.ts`) can fire the authored
`onSuccess` / `onFailed` / `onSettled` handlers.

- `login` → `user_identity` (success) or `auth_error` (failure); both echo
  `requestId`.
- `logout` → `user_identity` (guest) with the echoed `requestId`.
- `write_field` → `write_response` on success, `write_error` on failure.
- `recipe_load` / `recipe_save` → `recipe_response` on success (with the
  `DownloadResult` exposed as `$result` in handlers), `recipe_error` on failure.

Every deterministic failure path in `_handle_write_field` emits a `write_error`
immediately, so the client never waits out the 10 s timeout. Reason codes are a
stable contract the frontend `$switch`es on:

| Reason | Meaning |
| --- | --- |
| `invalid_credentials` | Login: username/password mismatch |
| `permission_denied`   | Write: client's group is not in the variable's `interactableByGroups` |
| `bad_request`         | Write: missing required field in the request payload |
| `bad_path`            | Write: datasource/path is unknown to the registry |
| `bad_field`           | Write: field cannot be resolved to an OPC-UA node id |
| `invalid_value`       | Write: value cannot be coerced to the variable's data type |
| `value_out_of_range`  | Write: coerced numeric value falls outside the variable's persisted `min`/`max` |
| `opcua_unreachable`   | Write: no engine for the datasource (not yet connected, or static-only) |
| `write_failed`        | Write: the OPC-UA `write_node` call raised |
| `array_index_out_of_bounds` | Write: an indexed write exceeds a fixed array's declared length |
| `array_state_unavailable` | Write: indexed array state is missing/stale, so siblings cannot be preserved safely |
| `verify_mismatch` | Write: `verify` was requested, the write itself succeeded, but reading the value back did not match what was written. Only reachable when the caller opts in — `recipe_load` with `verify: true` is the one producer today; `write_field` never sets it |

`invalid_value` follows the documented [OPC-UA write-coercion matrix](backend.md#opc-ua-write-coercion-matrix). The REST variable-write endpoint uses project-user HTTP Basic credentials, then calls the same request parser, `interactableByGroups` permission helper, coercer, and dispatcher.

`value_out_of_range` is checked only after coercion succeeds, against the variable's own (or, for a struct field, that field's own) persisted `min`/`max` — a hard operator-write constraint enforced identically for REST, WebSocket, and recipe writes since all three share `write_service.write_value`. A whole-array write is rejected if any element is out of range; an indexed element write is checked the same way. A persisted `min > max` is a contract violation, not a range: it is left unenforced (the write proceeds as if no range were configured) and logged once as a warning when the datasource loads.

Two further reason codes are synthesised by the **client** dispatcher and never
emitted by the backend: `timeout` (10 s elapsed with no response) and
`disconnected` (WebSocket closed with the request in flight, via
`useWebSocket.ts` → `flushAllAsDisconnected`). Requests without `requestId` are
still processed but produce no response.

## config_changed

Broadcast after every MCP- or REST-driven config write so other connected
browser tabs can refetch or surface conflicts.

```json
{
  "type": "config_changed",
  "artifact_type": "page",
  "artifact_ids": ["page-home"],
  "source": "mcp",
  "agent_label": "Claude@1.0",
  "summary": "Added Container widget 'w_abc' to 'page-home'",
  "diff": [ { "op": "add", "path": "/sections/content/0", "value": {} } ]
}
```

- `artifact_type ∈ page | datasource | alarms | translations | asset | variables | component`.
- `artifact_ids` is always an array — single-target writes send one element; bulk
  tools coalesce.
- `source` is `mcp` or `rest`. `agent_label` is included only when
  `source === "mcp"`.
- `diff` is an RFC 6902 JSON Patch. If the serialized JSON would exceed 32 KiB it
  is replaced by `{ "truncated": true, "reason": "patch_too_large", "op_count": N }`
  and consumers fall back to `summary`.

This WS broadcast is the **only** change notification. MCP-native
`notifications/resources/updated` and `notifications/resources/list_changed` are
**not** emitted — no MCP resources are exposed in the first place, so there is
nothing to subscribe to. An agent that mutates state must re-call the matching
`*_list` / `*_get` tool to observe the new value. See
[../reference/mcp.md](../reference/mcp.md) for the MCP-side contract.
