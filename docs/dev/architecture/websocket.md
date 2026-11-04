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
manager proxies to the child's `/ws`. Only the editor's socket needs a
device-admin session cookie; the runtime socket is public, like the rest of the
live view. The manager closes either upgrade with `1008` when the session is
missing (editor) or the project's users document is unusable, and with `1011`
when the project is not running. The child itself binds `127.0.0.1` and does
not authenticate `/ws`; it refuses only an upgrade carrying a foreign `Origin`,
which the manager's hop never sends.

Before any of that, an upgrade whose `Origin` header differs from the
request's own origin (scheme plus `Host`) is closed `1008` before accept, so
the handshake answers `403`: a socket ignores CORS, and without this a page on
any other site open in the panel's browser could read and write live values.
An upgrade with no `Origin` (a script, not a browser) passes. The rule and its
limits (reverse-proxy `Host`, dev proxy, DNS rebinding) are in
[rest-api.md](../reference/rest-api.md#authentication).

The manager opens a fresh upstream connection per browser socket and forwards
none of the browser's headers. On the editor prefix only, it sets
`x-nexthmi-editor: 1` (`core.audit.EDITOR_HEADER`) on that upstream
upgrade; the child marks such a connection as an editor socket
(`websocket_manager.connect(editor=True)`). A browser cannot forge the mark on
`/runtime/<slug>/ws`, since its headers never reach the child; a process on the
host can, by dialling the child's loopback port directly — the same trust the
child's `/api/internal/*` hooks rely on. The HTTP proxy carries the same mark on
every editor-prefix request and drops a browser's copy on both prefixes, so a
REST route can tell the editor apart too (see `POST /api/recipes/datasets/{id}/download`).

**Attribution.** A `write_field` / `toggle_field` that lands, a `recipe_load`
that writes at least one parameter, and an `alarm_ack` / `alarm_ack_all` are
recorded (audit event and, for acks, the alarm's `acked_by`) against the
connection: on a runtime socket the signed-in project user, or `guest`, with
`actor_source: "session"`; on an editor socket always `engineer`, with
`actor_source: "device_admin"`, whichever project user the editor's Test-mode
preview is signed in as. `login` / `logout` records keep the project user on
both. A recipe load over REST (the SDK's `recipeDownload`) carries no sign-in:
it is recorded as `guest` with `actor_source: "anonymous"`, or as `engineer`
when it came through the editor.

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
       "MyPLC:Motor1/Speed": {
         "type": { "kind": "scalar", "base": "Float", "array": false },
         "min": 0,
         "max": 3000,
         "writable": true
       },
       "MyPLC:Setpoints": {
         "type": { "kind": "scalar", "base": "Integer", "array": true, "length": 5 },
         "writable": false
       },
       "MyPLC:Motor1": {
         "type": { "kind": "struct", "name": "Motor1", "array": false, "fields": ["Speed", "sUnit", "Limits"] },
         "fieldRanges": { "Speed": { "min": 0, "max": 3000 } }
       }
     }
   }
   ```

   Every enabled leaf still present on the server, and every struct folder,
   has its own key, so a struct's members (`MyPLC:Motor1/Speed`, the nested
   `MyPLC:Motor1/Limits`) can be looked up beside it. A struct's `fields`
   lists all its leaves — disabled ones too — and its nested structs; a struct
   array's are those of its lowest-index element. `type` is the
   canonical `VarType` (`frontend/src/shared/types/varType.ts`). `min`/`max`
   appear on a scalar with a configured range, `fieldRanges` on a struct.
   `writable` is on every scalar: the variable's own `writable` flag (an
   OPC-UA node's access level as browsed, the authored flag on a static or
   test-server variable), `false` when unset. The runtime binding check reads
   it for a `write: true` field and for a struct field's `write: true`
   members, and the write path refuses a write to a variable where it is not
   `true` (`read_only`, below).

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
| `var_snapshot` | `{ type, values, bootId }` | Once on connect (empty `values`). `bootId` names the backend process; a client that sees it change on a reconnect knows the backend restarted, and the runtime (and an editor with nothing unsaved) reloads then. |
| `var_metadata` | `{ type, meta }` | Once on connect; variable shape metadata. |
| `var_update` | `{ type, values: { [compositeKey]: value } }` — see [Value forms](#value-forms) | Value changes. Batched in a 50 ms window; the per-datasource priority window is `settings.priority_ws_batch_ms`, clamped to `[0, 1000]`, default 10 ms. |
| `var_removed` | `{ type, ids: [compositeKey, ...] }` | Variables no longer available. |
| `opcua_status` | `{ type, datasource, connected }` | Per-datasource connection-state change. |
| `alarm_snapshot` | `{ type, active: AlarmInstance[], summary: AlarmSummary }` — an instance carries `value_refs` (its definition's `values` bindings) and `values` (their raw values at fire time), see [Alarm Files](data-formats.md#alarm-files) | On connect. |
| `alarm_update` | same shape as `alarm_snapshot`, `type: "alarm_update"` | On fire / clear / ack. |
| `recipe_snapshot` | `{ type, config: RecipeConfig, loaded: { [typeId]: { datasetId, loadedAt } }, lastResult }` | On connect. |
| `recipe_update` | same shape as `recipe_snapshot`, `type: "recipe_update"` | On config change / download / upload. |
| `recipe_response` | `{ type, requestId, result }` | A correlated `recipe_load` / `recipe_save` succeeded — `result` is the `DownloadResult` (load) or `{ datasetId }` (save). |
| `recipe_error` | `{ type, requestId, reason }` | A correlated `recipe_load` / `recipe_save` failed. |
| `alarm_ack_response` | `{ type, requestId }` | A correlated `alarm_ack` / `alarm_ack_all` succeeded. |
| `alarm_ack_error` | `{ type, requestId, reason }` | A correlated `alarm_ack` / `alarm_ack_all` failed: `not_found` (no active instance with that id), `bad_request` (no `instanceId`), `alarms_unavailable`. |
| `user_identity` | `{ type, scope, username, groups, groupLabels, sessionToken? }` | After `login`, `logout`, or `request_identity`. Also unprompted, with no `requestId`: for every scope on a named panel's connections when [API v1](../reference/rest-api.md#panel-sessions) signs that panel in or out, and for a scope whose user a `users` reload deleted, regrouped or gave a new password (see [Internal API](../reference/rest-api.md#internal-api)). `sessionToken` is present while the identity is a resumable login (see `request_identity`). |
| `auth_error` | `{ type, scope, reason }` | Failed `login`. `reason` is `"invalid_credentials"`, or `"rate_limited"` while the credential throttle is holding this username off. |
| `write_response` | `{ type, requestId, datasource, path }` | A correlated `write_field` or `toggle_field` succeeded — see [Action result correlation](#action-result-correlation). |
| `write_error` | `{ type, requestId, datasource, path, reason }` | A correlated `write_field` or `toggle_field` failed. |
| `restarting` | `{ type, reason }` | Right before the backend SIGTERMs itself for `POST /api/system/restart`. Clients disconnect and poll `/api/system/info` for the new process. |
| `widget_updated` | `{ type, key, name, ts, schema_ok }` | A custom widget recompiled or was deleted; `key` is its normalized path relative to `custom-widgets/`. |
| `config_changed` | see [config_changed](#config_changed) | After every MCP- or REST-driven config write. |
| `context_ready` | `{ type, currentPageIds: [string, ...] }` | Reply to `set_context`: every variable requested for `currentPageIds` has been sent, from cache and/or a fresh OPC-UA read. The id list is echoed verbatim, so an overlay — whose resolved page id is in that list — settles on this ack rather than on the grace timer. The client does **not** hold the page for it — a page renders as soon as its config and widget modules are in memory — it uses the ack to decide when a binding that still has no value is genuinely without data, and only then marks it (amber "no data" overlay). A page whose ack never arrives falls back to a 3 s grace. The client should ignore any `context_ready` whose page-set doesn't match its most recently sent `set_context` (a superseded navigation's background prefetch can still land late, and opening an overlay resends the context with its page appended). |

> Auto-login (`request_identity`) never carries a `requestId` in its
> `user_identity`, so the client dispatcher does not confuse it with a `login`
> response.

### Value forms

A `var_update` value is the value-cache entry verbatim, and the cache holds
only JSON-ready forms. An OPC-UA value is normalized where it leaves asyncua
(`opcua.values.normalize_value`, applied in the datachange handler and in
`read_current_values`); `DatasourceManager` passes every write through the
datasource-agnostic `core.value_types.json_ready` as well, so a static
datasource follows the same rules. Alarms, the historian and recipe uploads
read the same forms.

| Server value | Sent as |
|---|---|
| Boolean, String, Float/Double | JSON boolean / string / number |
| Integer within ±9,007,199,254,740,991 (`Number.MAX_SAFE_INTEGER`) | JSON number |
| Integer beyond that (an `Int64`/`UInt64` counter) | its decimal string, e.g. `"9223372036854775808"` — the form a write takes it back in |
| `DateTime` | ISO 8601 UTC with milliseconds and `Z`, e.g. `"2026-01-02T03:04:05.678Z"`; a server value without a zone is UTC; an offset-aware value whose instant has no UTC form (beyond year 1 or 9999) keeps its own offset, e.g. `"9999-12-31T23:59:59.000-01:00"`, rather than being clamped |
| `LocalizedText` | its text |
| `NodeId` / `ExpandedNodeId` / `QualifiedName` | canonical string, `"ns=3;s=Tag"` / `"2:Speed"` |
| `ByteString` | base64 |
| anything else (Guid, an undecoded structure) | its `str()` |
| array / struct | JSON array / object of the above |

A widget reading a number takes a decimal string as that number
(`usePropNumber` for a property, bound or not; `readNumberValue` for a value
that is not one — a struct field, a `useVariable` result, a raw value also
shown as text), so a counter beyond 2**53 still drives a
numeric field — rounded to the nearest double, as JavaScript holds it — while
a text field shows every digit. Numeric Stepper shows, steps, clamps and takes
numpad entry of such a value by its exact digits — a widget min/max written as
integer digits keeps them too — and writes it back as a string.

## Client → server messages

- `set_context` — update active page / overlay context for fast-subscription
  priority and prime the per-client priority set.

  ```json
  {
    "type": "set_context",
    "currentPageIds": ["home", "motor-detail"],
    "priorityKeys": ["MyPLC:Motor1"]
  }
  ```

  - `currentPageIds` is the only page-context key read. A frame sending
    anything else in its place carries no page context, and its bindings are
    never primed.
  - Hard caps: `currentPageIds` ≤ 2000, `priorityKeys`
    ≤ 5000. Excess entries are dropped silently.
  - The backend resolves bindings from the runtime pages config (walking nested
    `$if` / `$switch` / `$compare` expressions for `$var` references) and updates
    OPC-UA fast subscriptions accordingly.

  Current producers: `HmiView` (active page + open overlays), `PreviewView`
  (preview page/overlay context), `DatasourceVariableTable` (explicit
  `priorityKeys` for visible rows after scroll settle), `RecipeTable` (explicit
  `priorityKeys` for a recipe type's bound parameters while its Live column is
  on).

- `write_field` — write a value to a variable.

  ```json
  {
    "type": "write_field",
    "datasource": "MyPLC",
    "path": "Motor1",
    "field": "Speed",
    "value": 1200,
    "scope": "runtime:main",
    "requestId": "8f3c…"
  }
  ```

  - `datasource`, `path`, and `value` are required; a missing one is
    `bad_request`, a present `null` value is `invalid_value`. `field` selects a
    struct field; omit it for a scalar.
  - The runtime's `writeDataVariable` action names its variable with one sourced
    `target` (`{"$var": {"path": "<ds>:<path>", "index"?}}`); the client resolves
    it into this `datasource` / `path` pair, an `index` becoming a `[N]` suffix.
  - If the path ends with `[N]`, element `N` is patched into the current array
    and the full patched array is written — the current value is a fresh node
    read for OPC-UA, the in-memory cache for a static datasource.
  - A `bit` on the target becomes a `.N` suffix after any `[N]`
    (`Battery/Status.5`): bit `N` of a whole-number variable, the value a
    Boolean. The backend reads the whole word — a fresh node read for OPC-UA,
    never the cache; the cache for a static datasource — sets or clears the
    bit and writes the word back through the same path, so its access and
    range checks apply. A path the registry holds whole (a tag
    named `Motor.1`) is that tag, not a bit. A bit beyond the type's width, of
    a type with no bits, or of an array element is `bad_path`; a value that is
    not a Boolean is `invalid_value`.
  - The server does not check who is writing: any connection may write any
    writable variable. A variable entry may still carry the retired
    `interactableByGroups` key from an older project; it is ignored.
  - Values are coerced per the
    [OPC-UA write-coercion matrix](backend.md#opc-ua-write-coercion-matrix), then
    refused as `read_only` unless the variable written is marked `writable: true`,
    then checked against its `min`/`max`.
  - `static` datasources are updated in-process; OPC-UA datasources route through
    the pool engine.
  - `requestId` is optional. When supplied the backend replies with
    `write_response` / `write_error` (see below); when omitted the write is
    fire-and-forget with no response.

- `toggle_field` — invert a Boolean variable.

  ```json
  {
    "type": "toggle_field",
    "datasource": "MyPLC",
    "path": "Motor1/Run",
    "scope": "runtime:main",
    "requestId": "8f3c…"
  }
  ```

  - Same fields as `write_field` minus `value` and `field`; the
    `toggleDataVariable` action's `target` is resolved the same way. The backend reads
    the current value itself (a fresh node read for OPC-UA, the cache for a
    static datasource) and writes its inverse through `write_service.write_value`,
    so the read-only check, range check, audit record and reply are the same
    as a `write_field`. The client never sends the value: its copy may be stale.
  - A `.N` bit path toggles that bit of its word.
  - A variable whose `data_type` is not Boolean fails with `invalid_value`; one
    whose current value is not a boolean (never read, read failed) fails with
    `value_unavailable` and writes nothing.

- `recipe_load` — download a saved dataset.

  ```json
  { "type": "recipe_load", "datasetId": "espresso", "verify": true, "scope": "runtime:main", "requestId": "…" }
  ```

  - Writes every parameter's stored value via the shared `write_service`
    (continue-on-error). Records the dataset as loaded for its type.
  - Replies `recipe_response` (carrying the `DownloadResult`) or `recipe_error`
    when `requestId` is supplied; fire-and-forget otherwise.

- `recipe_save` — upload live values into a dataset.

  ```json
  { "type": "recipe_save", "datasetId": "espresso", "scope": "runtime:main", "requestId": "…" }
  ```

  - An omitted `datasetId` targets the currently-loaded dataset when exactly one
    type is loaded (otherwise `recipe_error` with `bad_request`). `updatedBy` is
    the scope's signed-in user (empty when the scope has no identity), or
    `engineer` on an editor socket.

- `alarm_ack` / `alarm_ack_all` — acknowledge one active alarm, or every one.

  ```json
  { "type": "alarm_ack", "instanceId": "…", "requestId": "…" }
  { "type": "alarm_ack_all", "requestId": "…" }
  ```

  - The acknowledgement is recorded against this connection, never against a
    name in the message (any `username` is ignored): the identity the socket
    established most recently — its signed-in user, or `guest` when nobody
    signed in. The message carries no `scope` because the SDK's `ackAlarm` has
    none to send; a runtime tab holds one live view, so its latest identity is
    the screen the operator is looking at.
  - Acknowledging an already-acked alarm succeeds and changes nothing.
  - Replies `alarm_ack_response` / `alarm_ack_error` when `requestId` is
    supplied; fire-and-forget otherwise. The resulting state reaches every
    client as `alarm_update`.

- `login` — authenticate a scope.

  ```json
  { "type": "login", "scope": "runtime:main", "username": "admin", "password": "...", "requestId": "…" }
  ```

  - On match the scope identity is updated and `user_identity` is sent back; on
    mismatch the server sends `auth_error`. Both echo `requestId` when supplied.
  - A successful login carries a `sessionToken`. The runtime keeps it in
    `sessionStorage` (per tab) and sends it with `request_identity`, so a
    reconnect or reload stays logged in. It saves the token of a
    `user_identity` only for the live view's scope (the last to send
    `request_identity`, `isLiveScope` in `runtimeSession.ts`), so a stale
    scope a remounted view left on the socket cannot replace it.
  - The scope's previous `sessionToken`, if any, is revoked, and every other
    scope still holding it (the other monitors of a panel signed in over API v1,
    a tab that resumed it) reverts to the auto-login user with an unprompted
    `user_identity`.

- `logout` — revert a scope to the auto-login user (`settings.autoLoginName`,
  `guest` when that user is missing), the identity `request_identity` and an
  API v1 panel sign-out give.

  ```json
  { "type": "logout", "scope": "runtime:main", "requestId": "…" }
  ```

  - Sends a `user_identity` with that identity (echoing `requestId`), and
    revokes the scope's `sessionToken`. Every other scope holding the same
    token reverts to it too, so all monitors of a panel signed in over
    API v1 sign out together. A logout that ends no `sessionToken` is not
    audited.

- `request_identity` — resume the login `sessionToken` names, or else auto-login
  the configured `settings.autoLoginName` user for a scope (falls back to `guest`).

  ```json
  { "type": "request_identity", "scope": "runtime:main", "sessionToken": "…", "panel": "line-a-1" }
  ```

  - Always followed by a `user_identity`; never carries `requestId`.
  - `panel` (optional) names the connection's panel: the runtime tab's
    `?panel=` URL parameter, which the tab keeps in `sessionStorage` because
    in-app navigation drops the query string (`loadPanelName` in
    `frontend/src/hmi/utils/runtimeSession.ts`). It must match
    `[A-Za-z0-9_-]{1,64}`; any other value, or none, leaves the connection
    unnamed. Each `request_identity` replaces the connection's name. An editor
    connection is never named. API v1 targets named connections only.
  - A token resumes while its user still exists and it was used in the last
    12 hours; the user's groups are re-read. Tokens live in backend memory, so a
    backend restart ends every login.

All `scope` values must be non-empty strings; empty / missing scopes cause the
message to be ignored silently.

## Action result correlation

Client-fired async actions (`login`, `logout`, `write_field`, `toggle_field`, `recipe_load`,
`recipe_save`, `alarm_ack`, `alarm_ack_all`) accept an optional `requestId` (UUID). When supplied, the backend
echoes it on the corresponding response so the frontend dispatcher
(`frontend/src/hmi/utils/actionDispatcher.ts`) can fire the authored
`onSuccess` / `onFailed` / `onSettled` handlers.

- `login` → `user_identity` (success) or `auth_error` (failure); both echo
  `requestId`.
- `logout` → `user_identity` (the auto-login user) with the echoed `requestId`.
- `write_field` / `toggle_field` → `write_response` on success, `write_error` on failure.
- `recipe_load` / `recipe_save` → `recipe_response` on success (with the
  `DownloadResult` exposed as `$result` in handlers), `recipe_error` on failure.
- `alarm_ack` / `alarm_ack_all` → `alarm_ack_response` on success,
  `alarm_ack_error` on failure.

Every deterministic failure path in `_handle_write_field` and `_handle_toggle_field` emits a `write_error`
immediately, so the client never waits out the 10 s timeout. Reason codes are a
stable contract the frontend `$switch`es on:

| Reason | Meaning |
| --- | --- |
| `invalid_credentials` | Login: username/password mismatch — including every account with no password set, which can never be signed in as |
| `rate_limited`        | Login: too many failed attempts for this username (or across all of them); the right password is refused too until the lockout expires. `users_manager.authenticate` raises `RateLimitError`, which the REST credential routes answer as HTTP `429` |
| `bad_request`         | Write: missing required field in the request payload |
| `bad_path`            | Write: datasource/path is unknown to the registry |
| `bad_field`           | Write: field cannot be resolved to an OPC-UA node id |
| `invalid_value`       | Write: value cannot be coerced to the variable's data type |
| `value_out_of_range`  | Write: the numeric value, as entered (before any Float32 rounding), falls outside the variable's persisted `min`/`max` |
| `read_only`           | Write / toggle: the variable written — for an element, its array; for a struct field, that member — does not have `writable: true`. Nothing is written |
| `opcua_unreachable`   | Write: no engine for the datasource (not yet connected, or static-only) |
| `write_failed`        | Write: the OPC-UA `write_node` call raised |
| `array_index_out_of_bounds` | Write: an indexed write exceeds a fixed array's declared length |
| `array_state_unavailable` | Write: indexed array state is missing/stale, so siblings cannot be preserved safely |
| `value_unavailable` | Toggle: the variable's current value is not a known boolean, so there is nothing to invert |
| `verify_mismatch` | Write: `verify` was requested, the write itself succeeded, but reading the value back did not match what was written. Only reachable when the caller opts in — `recipe_load` with `verify: true` is the one producer today; `write_field` never sets it |

`invalid_value` follows the documented [OPC-UA write-coercion matrix](backend.md#opc-ua-write-coercion-matrix). The REST variable-write endpoint uses project-user HTTP Basic credentials, then calls the same request parser, coercer, and dispatcher.

`read_only` is checked in `write_service.write_value` (and in `toggle_value`, before the Boolean check and the read), so the WebSocket, REST and recipe-download writes refuse it alike; a recipe download reports it per parameter in `failures`. It comes after `bad_path` and `bad_field` and before everything about the index or the value — `array_index_out_of_bounds`, `invalid_value`, `value_out_of_range` — since no other value could make the write succeed. A whole-struct payload names a folder with no access of its own and stays `invalid_value`. `useWriteVariable` pre-flights it in the same order: a variable whose metadata says `writable: false` is reported `read_only` before its value is coerced. A variable that states no access at all is read-only, the same reading the editor and the runtime overlay give it.

`value_out_of_range` is checked only after coercion succeeds, against the variable's own (or, for a struct field, that field's own) persisted `min`/`max` — a hard operator-write constraint enforced identically for REST, WebSocket, and recipe writes since all three share `write_service.write_value`. It judges the value as entered: a `Float` (float32) write is rounded to the nearest float32 only after the check, so 19.9 against a minimum of 19.9 is accepted although it is stored as 19.89999962. A whole-array write is rejected if any element is out of range; an indexed element write is checked the same way. A persisted `min > max` is a contract violation, not a range: it is left unenforced (the write proceeds as if no range were configured) and logged once as a warning when the datasource loads.

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
  "agent_label": "Claude_1_0",
  "summary": "Added Container widget 'w_abc' to 'page-home'",
  "diff": [ { "op": "add", "path": "/sections/content/0", "value": {} } ]
}
```

- `artifact_type ∈ page | datasource | alarms | translations | asset | variables | component | users`.
- `artifact_ids` is always an array — single-target writes send one element; bulk
  tools coalesce.
- `source` is `mcp`, `rest` or `api` (an [API v1](../reference/rest-api.md#api-v1) user write). `agent_label` is included only when
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
