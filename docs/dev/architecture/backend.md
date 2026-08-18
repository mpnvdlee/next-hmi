# NEXT HMI Backend Architecture

Back to architecture hub: [overview.md](overview.md).

## Scope

The backend ships **two ASGI apps** built from the same package:

- **`backend/main.py`** — the single-project app. One process serves one project's live pipeline (datasources, OPC-UA, WebSocket, alarms). The runtime runs N of these, one per *running* project, each pinned to its project and served under a URL prefix.
- **`backend/manager.py`** — the always-on front door. It loads no project pipeline; it serves the dashboard, gates access behind a device-admin password, supervises the per-project child processes, and reverse-proxies `/runtime/<slug>/*` and `/editor/<slug>/*` to them. See **Manager And Supervisor** below.

The single-project app owns:

- persisted files inside the project folder it is pinned to, located via `NEXTHMI_ACTIVE_PROJECT_PATH` — set by the supervisor for a managed instance, or self-pinned at startup by a standalone `uvicorn main:app` process (see **Bootstrap** below)
- the project lifecycle API surface: list / create / locate / delete / export / import and authenticated manager-to-manager transfer (`make-live` is retired — see below)
- datasource lifecycle management
- OPC-UA client and test-server orchestration
- alarm trigger evaluation and active/history state
- widget definition CRUD
- WebSocket fan-out for live variable + alarm updates
- custom-component static file serving

LAN peer discovery (mDNS) and every peer-transfer surface belong to the manager alone — a project instance never advertises itself or accepts a peer connection.

## Main Modules

- `backend/main.py`
  - wires dependencies
  - registers routers
  - starts and stops background services
  - mounts `/widgets`, `/widget-js`, `/external-libraries`, and `/assets`
- `backend/core/runtime_home.py`
  - per-installation home directory (manifest, `.logs/`, `.widget-build/`, restart sentinel)
  - resolves from `NEXTHMI_DATA_DIR` → bootstrap config → platform default
- `backend/core/manifest.py`
  - `projects.json` model (`ManifestV1`, `ProjectEntry`, `PeerEntry`) with atomic load/save
  - per-project metadata helpers for the embedded `config.json` `project` block (`ensure_project_metadata()`)
  - slug + collision-suffix helpers for default project folder paths
- `backend/core/storage.py`
  - active-project path resolvers (`active_project_root()`, `active_assets_dir()`, `active_custom_widgets_dir()`, etc.) — re-read the manifest on every call
  - runtime-home-anchored constants (`LOGS_DIR`, `WIDGET_BUILD_DIR`)
  - JSON and CSV persistence helpers
  - `NoLiveProjectError` — raised by the active resolvers when no project is marked live; mapped to 409 `{code: "no_live_project"}` by the registered handler
- `backend/core/project_packer.py`
  - one zip code path for export, import, and manager peer transfer — `pack_project()` / `unpack_project()` with symlink + traversal + size-cap guards
- `backend/core/peer_discovery.py`
  - mDNS advertise/browse over `_nexthmi._tcp.local.`; per-process `runtimeId` so multiple ports on one host don't shadow each other. Started only by the manager.
- `backend/core/exceptions.py`
  - domain exception hierarchy (`NextHmiError`, `NotFoundError`, `ConflictError`, `ValidationError`, `InternalError`)
  - `register_exception_handlers(app)` — maps domain exceptions to consistent JSON error responses
- `backend/core/audit.py`
  - generic event-emission seam (`emit()` / `emit_async()` fan out to `register_listener()`-ed callbacks); the public build registers no listeners, so it is a no-op here — audit trail is an enterprise feature
- `backend/core/start_guards.py`
  - generic instance-start seam (`refusal(project_id)` asks each `register_guard()`-ed callback whether the supervisor may spawn a child, and returns the first refusal sentence); the public build registers no guards, so it always returns `None` here — runtime activation is an enterprise feature. Fails open on a raising guard
- `backend/models/websocket.py`
  - TypedDict definitions for **part** of the WebSocket protocol — not all of it
  - client→server: `SetContextMessage`, `WriteFieldMessage`, `LoginMessage`, `LogoutMessage`, `RequestIdentityMessage`
  - server→client: `VarSnapshotMessage`, `VarUpdateMessage`, `VarRemovedMessage`, `OpcuaStatusMessage`, `ContextReadyMessage`, `UserIdentityMessage`, `AuthErrorMessage`, `WriteResponseMessage`, `WriteErrorMessage`
  - **untyped** (constructed as plain dicts at the send site): `var_metadata`, the recipe family (`recipe_load` / `recipe_save` / `recipe_snapshot` / `recipe_update` / `recipe_response` / `recipe_error`), `alarm_snapshot`, `alarm_update`, `restarting`, `widget_updated`, `config_changed`
  - alarm broadcast types are documented inline in `services/alarm_manager.py` (`alarm_snapshot`, `alarm_update`)
  - [websocket.md](websocket.md), not this module, is the specification of the full wire protocol
- `backend/models/alarm.py`
  - `AlarmTrigger`, `AlarmDefinition`, `AlarmGroup`, `AlarmConfig`
  - `AlarmInstance`, `AlarmHistoryEntry`, `AlarmSummary`, `AlarmState`
- `backend/models/component.py`
  - `WidgetPropertySchema`, `ComponentDefinition`
- `backend/services/datasource_manager.py`
  - datasource registry
  - flattened variable lookup tables
  - cached live values
  - priority-key aggregation across clients
  - all public methods protected by `threading.Lock`; payloads copied before lock release
  - `register_value_listener(fn)` / `unregister_value_listener(fn)` — idempotent register/remove for downstream listeners (alarm manager, historian manager). Listener fan-out copies the list under the lock so a slow listener can't block subsequent updates.
- `backend/services/websocket_manager.py`
  - WebSocket connection tracking
  - batched `var_update` broadcasting (priority + normal windows)
  - alarm update fan-out (`broadcast_alarm_update`)
  - client message handling
- `backend/services/alarm_manager.py`
  - thread-safe singleton; registered as a value listener on `datasource_manager`
  - evaluates `value_range` and `bool` triggers; fires/clears active alarms
  - persists config to `alarms.json` and runtime state to `alarm_state.json`
  - exposes `ack_alarm()`, `ack_all()`, `get_summary()`, `build_snapshot_payload()`
  - bridges sync ack handlers into the asyncio loop via a callback wired in `main.py`
- `backend/services/write_service.py`
  - shared variable-write path: coerce → static/OPC-UA dispatch → write, with optional verify read-back
  - handles scalars and whole-array values; returns a structured `WriteOutcome` with a reason on failure
  - single source of truth for authenticated REST writes, `websocket_manager._handle_write_field`, and recipe downloads; REST uses HTTP Basic with project-user credentials, while WebSocket uses its scoped project-user identity, and both call the same group-permission helper

### OPC-UA write-coercion matrix

Raw type matching is case-insensitive and trims surrounding whitespace. The
frontend predictor and backend coercer use the same matrix, guarded by the
cross-language `opcuaWriteTypes.json` and `opcuaWriteCoercion.json` fixtures.
Persisted raw strings are never rewritten while loading a datasource; an
unrecognised persisted type can still be displayed, but a write to it is
rejected.

| Canonical type | Raw/persisted names | Accepted scalar input | Coerced output | Rejected |
| --- | --- | --- | --- | --- |
| `Boolean` | `Boolean`, `Bool` | boolean; integer `0`/`1`; strings `true/false`, `1/0`, `on/off`, `yes/no` | boolean | all other numbers/strings/containers/null |
| `Integer` | `Integer`, `Int`, `Enumeration`, `SByte`, `Byte`, `Int8`, `UInt8`, `Int16`, `UInt16`, `Int32`, `UInt32`, `Int64`, `UInt64` | JSON-safe integer number, integral finite float, or base-10 integer string; use a string beyond ±9,007,199,254,740,991 | integer | booleans, fractions, unsafe JSON numbers, malformed strings, and values outside the raw type's range; canonical `Integer`/`Int`/`Enumeration` use signed 32-bit range |
| `Float` | `Float`, `Single`, `Double` | finite number or decimal string using `[+-]digits[.digits][e[+-]digits]` | finite number | booleans, underscores/hex, empty/malformed strings, NaN, and infinities; `Float`/`Single` additionally reject values beyond Float32 range or values that would round when serialized to Float32, while `Double` uses finite Float64 |
| `String` | `String` | string, number, or boolean | string; numbers follow ECMAScript formatting (`0` for either zero sign, decimal for magnitudes from `1e-6` through below `1e21`, normalized exponent otherwise) | containers, null, NaN, and infinities |
| `DateTime` | `DateTime` | `datetime` internally or an ISO-8601 string containing date and time | Python `datetime` on the backend; the frontend retains the validated string | date-only/malformed strings, other values, null |
| `Date` | `Date` | ISO `YYYY-MM-DD` string (or Python `date` internally) | ISO date string | impossible/malformed dates, datetimes, other values, null |
| `Time` | `Time` | ISO `HH:MM[:SS[.ffffff]]` string (or Python `time` internally) | ISO time string | out-of-range/malformed times, other values, null |
| `Duration` | `Duration`, `TimeSpan` | finite seconds as a number or clean numeric string | finite number | booleans, ISO-duration text, NaN/infinities, null |

Scalar-array targets require a JSON array; every element follows the scalar
row, and fixed arrays require the declared length exactly. Indexed array writes
require one scalar and retain the existing `array_index_out_of_bounds` failure
for an invalid fixed-array index; dynamic indexed writes are capped at index
10,000. OPC-UA indexed writes read the current node value before patching it;
static indexed writes use the datasource's in-memory value. Both reject missing,
short, or long state as `array_state_unavailable`, never trust stale OPC-UA cache
siblings, and never zero-fill or grow a dynamic array. Array descriptors accept only
boolean `is_array`; absent, null, zero, and negative lengths are dynamic, while
a positive integer is fixed. Scalar targets reject arrays. Whole struct and
struct-array payloads remain unsupported because OPC-UA structs in this system
are folders of independently addressed field nodes; callers write a leaf path
or the existing `field` target instead. Both aggregate shapes are therefore
rejected rather than partially written.

All matrix failures are exposed by REST and WebSocket as the stable
`invalid_value` reason. Internally/frontend diagnostics retain the more specific
stable reason: `null_not_allowed`, `unknown_type`, `scalar_required`,
`array_required`, `array_length_mismatch`, `invalid_boolean`, `invalid_integer`,
`integer_out_of_range`, `lossy_conversion`, `invalid_float`,
`non_finite_float`, `float_out_of_range`, `invalid_string`, `invalid_temporal`,
or `invalid_descriptor`. Invalid indexed targets retain the public
`array_index_out_of_bounds` or `array_state_unavailable` reasons.

`ByteString`, `Guid`, `NodeId`, and `Decimal` remain valid persisted/display raw type names,
but writes reject them as `unknown_type`: their asyncua wire values require
binary/UUID/NodeId objects that cannot be safely inferred from an operator
string. Intentional contract additions are canonical `Integer`, `Date`, `Time`,
and `Duration` writes plus the aliases `Int`, `Enumeration`, and `TimeSpan`. They are bounded
by the matrix above; unknown raw types are intentionally no longer passed
through. Existing valid boolean aliases, numeric strings, primitive-to-String
conversion, ISO `DateTime`, raw integer types/ranges, exactly representable
Float32 values, finite Float64 values, and persisted raw type loading remain
compatible.

The intentional safety rejections are present nulls, unsafe/lossy integer
numbers, rounded or out-of-range Float32 values, malformed/non-finite numeric
strings, scalar/array shape mismatches, invalid array descriptors, and unknown
or unsupported raw types. These values previously reached dispatch and could
be truncated, inferred as the wrong Variant type, or fail only inside asyncua.

**Configured range enforcement.** After a numeric value survives the matrix
above, `write_service.write_value` checks it against the variable's own
persisted `min`/`max` (a struct field's write is checked against that field's
own `min`/`max`, not its parent's) — a hard operator-write constraint shared by
REST, WebSocket, and recipe writes. A whole-array write is rejected if any
element is out of range; either bound may be absent to leave that side
unenforced. A persisted `min > max` is a contract violation rather than a
usable range: `DatasourceEntry` logs it once as a warning when the datasource
loads, and writes remain unenforced for that variable until an author corrects
it. This range check is independent of the coercion matrix and surfaces its
own stable REST/WebSocket reason, `value_out_of_range` (see
[websocket.md](websocket.md) for the full reason table).

- `backend/services/recipe_manager.py`
  - thread-safe singleton; persists config to `recipes.json` and the loaded-per-type pointer to `recipe_state.json`
  - `download()` writes a dataset's values via `write_service` (continue-on-error, optional exact-match verify); `upload_into()` reads live values back into a dataset in place
  - never holds the lock across an `await`: snapshots under the lock, does the async writes/reads, re-acquires to record results; broadcasts `recipe_update`
- `backend/services/component_manager.py`
  - per-file CRUD against `<live-project>/components/<id>.json`
  - recursively rejects `$var` sources in child values and component-property defaults (use `$componentProp` instead)
  - rejects nested reusable components (`$component:` types inside another component)
  - scans every persisted file before metadata migration; binding-invalid files stay byte-for-byte unchanged, malformed JSON/invalid UTF-8/unreadable files fail closed, and component roots, directories, or files that are symlinks or Windows reparse points are rejected without traversal
- `backend/opcua/client_pool.py`
  - OPC-UA client pool and reconnect logic
- `backend/opcua/test_server.py`
  - in-process OPC-UA test-server pool
  - simulated values are index-derived waves per node; a variable carrying both `sim_min` and `sim_max` (with `min < max`) oscillates inside that band instead, so a node with a real-world range stops swinging to nonsense. Incomplete, inverted or non-numeric bounds fall back to the default wave
- `backend/models/theme.py`
  - Pydantic models: `ThemeColors`, `ThemeTypography`, `ThemeSpacing`, `ThemeConfig`
  - `ThemeValidationIssue` (shared `{level, code, path, message}` shape for both errors and warnings), `ThemeValidationResult`
  - `validate_theme()` — domain diagnostics (WCAG contrast, 4 pairs) for an already-parsed `ThemeConfig`
  - `validate_theme_payload()` — validates a raw dict, converting fatal pydantic parse failures into `ThemeValidationResult(valid=False, errors=[...])` instead of a differently-shaped 422; this is what the `/validate` endpoints call
- `backend/services/theme_manager.py`
  - thread-safe multi-theme persistence singleton + the default-theme pointer
  - methods: `list_ids()`, `list_all()`, `get()`, `save()`, `create()`, `delete()`, `get_default_id()`, `set_default_id()`
  - `save()` re-validates via `validate_theme()` before writing, so a domain-invalid theme is never persisted even though it is already structurally valid `ThemeConfig` by that point
  - reads/writes `<live-project>/themes/<id>.json`; stores the default id in `config.json`'s `project.defaultTheme`. Seeds `themes/default.json` from defaults on first access if no theme exists yet — a theme file is read as-is, with no legacy shape and no read-time normalization
- `backend/api/config_api.py`
  - pages, dictionaries, translations, languages, `globalEvents`
- `backend/api/datasource_api.py`
  - datasource CRUD, browse, lifecycle, variable-tree update
- `backend/api/alarm_api.py`
  - alarm config CRUD, active/history/summary, single + all acknowledge
- `backend/api/component_api.py`
  - widget definition CRUD
- `backend/api/theme_api.py`
  - multi-theme CRUD + validation (`/api/themes`) and the default-theme pointer (`/api/default-theme`)
- `backend/api/widgets_api.py`
  - custom-component discovery metadata
- `backend/api/system_api.py`
  - process info, subscription status, restart, runtime home / default projects root
- `backend/api/users_api.py`
  - users, groups, and access settings
- `backend/api/projects_api.py`
  - list / create / locate / delete / validate-path; export zip; import zip. (`make-live` is removed — the supervisor's running set replaces the single-live model; `delete` now refuses a project that is in the manifest `running` set rather than the old single live project.) No push/pull here — that's `manager_peers_api.py`, manager-only.
- `backend/api/supervisor_api.py` (manager only)
  - `GET /api/manager/running`, `POST /api/manager/projects/{id}/start`, `POST .../stop`, `GET .../status` — drive and report the per-project child processes.
- `backend/api/manager_auth_api.py` (manager only)
  - `GET /api/manager/auth/status`, `POST .../setup` (first-run password), `POST .../login`, `POST .../logout` — device-admin session cookie.
- `backend/api/manager_peers_api.py` (manager only)
  - manager discovery, device-admin pairing, hashed/revocable peer tokens, explicit source/destination transfer, target-root receive, collision policy, progress/cancellation, and idempotent retry. The only peer-transfer surface — no project instance mounts one.

## Edition Seam

This repository builds one edition: `oss`. There is no license check, no
license storage, and no `/api/admin` route group in it.

`launcher._load_edition_app(base)` is the entrypoint half of the seam.
`NEXTHMI_EDITION` (default `oss`) picks the ASGI entrypoint: `manager` / `main`
for `oss`, `manager_enterprise` / `main_enterprise` for `ee`. The `_enterprise`
twins are not in this repository — they ship only in the enterprise build,
where they import the core app and mount additional routers on top. An `oss`
build cannot reach them even with the variable set; it exits with a legible
message instead. `backend/tests/test_edition_separation.py` asserts that
`launcher.py` stays the only module naming an `ee` entrypoint and that no core
module imports enterprise code.

Two **registration seams** carry behaviour the entrypoint cannot, because it
has to reach code the core already owns. Both are generic plumbing with no
policy of their own, and the public build registers nothing with either — so
both are inert here, and deleting them from an AGPL checkout would change
nothing about how this build behaves:

| Seam | Core calls it | An `ee` build registers |
|---|---|---|
| `core/audit.py` | `emit()` at each attributed operator action | a listener that records the event (see [Edition Seam](#edition-seam)) |
| `core/start_guards.py` | `refusal()` in `Supervisor.start` and `_handle_crash` | a guard that refuses instance starts until the installation is activated by licence |

`start_guards` fails **open**: a guard that raises is logged and skipped, so a
broken gate cannot hold a factory's screens down. It is consulted only on the
paths that *spawn* a child, never against a live instance — an enterprise
licence that lapses stops the next start, not a running line.

## Manager And Supervisor

The **manager** (`backend/manager.py`) is the ASGI app the launcher runs by default (*manager mode*). It is deliberately lightweight — it never imports a project's datasource/OPC-UA/WebSocket pipeline. Responsibilities:

- **Auth gate** — an HTTP middleware (`_auth_gate`) requires a valid device-admin session cookie for every `/api/*`, `/runtime/*`, and `/editor/*` request, except `/api/manager/auth/*`, bearer-authenticated `/api/manager/peer/*`, and `/api/health`. The SPA shell + bundle stay public so the login screen can render. A rejected request answers `401 {"detail": …, "code": "manager_session_required"}`, except a top-level browser navigation to `/runtime/*` or `/editor/*`, which is redirected (303) to `/?signIn=<original path>` so it lands on the sign-in screen and is returned to its destination afterwards (`safe_sign_in_target` restricts the round-trip to same-origin project paths). The frontend keys its "signed out" overlay off that code — see [Frontend](frontend.md). Auth lives in `core/manager_auth.py`: a PBKDF2-HMAC-SHA256 password digest in `<runtime_home>/.manager-auth.json`, stateless HMAC-signed session tokens (cookie `nexthmi_manager_session`), and an in-memory login throttle (lock after 5 failures for 60 s → HTTP 429 `RateLimitError`).
- **Reverse proxy** — `GET/POST/... /runtime/{project_id}/{path}` (and the `/editor/{project_id}/...` alias) streams to the matching child over `httpx` (loopback `127.0.0.1:<port>` from `supervisor.port_for`); `/runtime/{id}/ws` / `/editor/{id}/ws` bridges the browser WebSocket to the child's `/ws`. Hop-by-hop headers are dropped and the manager session cookie is stripped before forwarding (children are trusted localhost processes). A request for a project that isn't running returns 503. (The legacy `/p/{id}/` alias was removed outright rather than deprecated for a compatibility period — backlog R24/R51.)
- **Routers** — mounts the `manager_auth`, `supervisor`, `projects`, and `manager_peers` routers.
- **Usage reporting** — `core/telemetry.py` starts a background task in the manager lifespan that POSTs an install-count ping (installation ID, version, edition, platform) at start-up and every 24 h. Best-effort by contract: failures are debug-logged and never retried. Off through `NEXTHMI_TELEMETRY=off` or the Settings switch; see the [Telemetry API](../reference/rest-api.md#telemetry-api).
- **Manager SPA** — serves the same frontend bundle at the origin root with `mode="manager"` (the dashboard) and base `"/"`; project instances are served their HMI/config app under `/runtime/<slug>/` or `/editor/<slug>/` with `mode="instance"`.

The **supervisor** (`backend/services/supervisor.py`) is a singleton owned by the manager:

- starts/stops one child process per running project (`launcher.py --serve-project <path> --base-path /runtime/<slug>/ --port <ephemeral>` in source; the frozen binary in a packaged build), each bound to `127.0.0.1`. The spawn-time default base path is `/runtime/<slug>/` — the manager's `X-Forwarded-Prefix` header overrides it when a request actually comes in through `/editor/<slug>/`.
- health-checks a freshly started child (`/api/health`) before reporting it `running`; auto-restarts a child that exits unexpectedly with exponential backoff and a circuit breaker that flips it to `crashed` after >5 restarts in 60 s.
- persists the running set to the manifest (`running[]`) so `resume_all()` can bring projects back after a manager restart, re-binding the previous port when still free.
- `running_snapshot()` returns per-instance `{id, name, path, basePath, port, pid, status, startedAt, restarts, lastError}` for the dashboard. `status ∈ {starting, running, stopped, crashed}`.

`backend/services/project_resume.py` (`prepare_running_set`) runs once in the manager lifespan before `resume_all()`: on a fresh install with no projects at all, it seeds the bundled project and leaves it stopped while operator-password setup is pending. Existing projects recorded in the running set are resumed, while an operator who deliberately stopped everything is respected.

## Startup And Shutdown

The **manager** lifespan opens the proxy `httpx` client, runs `project_resume.prepare_running_set()` then `supervisor.resume_all()`, starts mDNS peer discovery and the usage-reporting task, and on shutdown calls `supervisor.shutdown()` (terminates every child), stops discovery and the reporting task, and closes the proxy client.

In a **project instance** (`backend/main.py`), startup performs these steps:

1. resolve the active project via `NEXTHMI_ACTIVE_PROJECT_PATH` — set by the supervisor when it pinned this instance, or self-pinned by this process after `project_bootstrap.ensure_default_project()` when running standalone (`uvicorn main:app` with no supervisor). In instance mode the default-project bootstrap is skipped (the supervisor already pinned a project; bootstrapping would pollute the shared manifest)
2. load users; load alarm config + state; load the widget directory
3. capture the running event loop (so sync handlers can schedule alarm broadcasts)
4. load datasource JSON files from `<live-project>/datasources/`
5. start the historian manager (registers its value listener, opens the SQLite db, starts the batch writer + retention loops). Failures are logged but don't abort startup. The historian starts before the broadcast loop so its value listener catches every emit.
6. start configured test servers
7. start configured OPC-UA clients
8. start the WebSocket broadcast loop

A project instance never starts mDNS peer discovery — that, like every peer-transfer surface, belongs to the manager alone.

Every router and manager in this repository mounts unconditionally — there is
no feature gate and nothing to license. (An `ee` instance app adds one
conditional mount of its own on top, from the private repository; see
[Edition Seam](#edition-seam).)

Shutdown cancels the broadcast loop, stops the historian manager (flushes the buffer, closes the db), and stops OPC-UA clients and test servers.

A managed instance is always pinned to a project, so it never hits the "no project" path — nor does a standalone instance, since bootstrap self-pins `NEXTHMI_ACTIVE_PROJECT_PATH` before any request can be served. The resolvers still raise `NoLiveProjectError` (→ 409 `{code: "no_live_project"}`) if a process is ever started with neither the env var set nor bootstrap able to run (e.g. it was cleared after startup); the SPA renders a "no project on this server" card. Project selection and lifecycle now live in the manager dashboard, not an in-app `/projects` route.

`alarm_manager` is registered as a `datasource_manager` value listener at module load, and its broadcast callback is bridged into the asyncio loop so ack endpoints (called from sync threadpool routes) can still emit `alarm_update` messages.

## Persistence Layer

Paths come from two sources, both in `backend/core/`:

- **Runtime-home-anchored** (`runtime_home.py`) — frozen at process start; pinned per-installation, never project-scoped:
  - `runtime_home_path()` — `<runtime_home>/` (defaults to `~/Documents/NextHMI/`)
  - `manifest_path()` — `<runtime_home>/projects.json`
  - `logs_dir()` / `widget_build_dir()` / `restart_sentinel_path()`
- **Project-anchored** (`storage.py`) — `_active_project_path()` resolves on every call: a per-call `use_project()` scope (multi-project MCP) wins outright, else `NEXTHMI_ACTIVE_PROJECT_PATH` — set per child by the supervisor, or self-pinned by a standalone process at bootstrap — so N children each serve a different project in one runtime home:
  - `active_project_root()` — the project folder
  - `active_datasources_dir()`, `active_pages_dir()`, `active_components_dir()` (widgets), `active_translations_dir()`
  - `active_alarms_config_path()`, `active_alarm_state_path()`
  - `active_custom_widgets_dir()`, `active_external_libraries_dir()`
  - `active_assets_dir()`, `active_icons_dir()`, `active_images_dir()`

`ensure_active_project_dirs()` creates the project subdirectories on first launch (and after any live-project switch). The runtime-home subdirectories (`.logs/`, `.widget-build/`) are created on first write.

`Default.csv` is seeded with an `en-EN` header on first run inside the live project's `translations/` folder. The backend uses atomic write helpers for both JSON and CSV files.

## Datasource Manager

Each datasource is represented by a `DatasourceEntry` with:

- `config`
- `registry`: flat variable map keyed by slash-joined path
- `folder_registry`: struct-folder map keyed by folder path
- `cache`: live values keyed by `datasource:path`

Important behaviors:

- static datasource values are loaded directly into cache from the config file
- folder variables are exposed as aggregate struct objects in addition to child scalar values
- struct folders support nesting: child folders that are themselves structs are recorded as `_nested_fields` on the parent entry; the snapshot builder recursively assembles nested dicts
- array-of-struct folders (children matching `[0]`, `[1]`, …) are detected during `_build_folder_maps()` and marked with `_is_array`, `_array_length`, and `_element_paths`; their snapshot is a list of dicts
- `_wire_ancestor_map()` rewrites `_var_to_folder` so every leaf variable — including those inside nested sub-folders — maps to the topmost ancestor struct; this ensures a single datachange triggers a full re-snapshot of the entire aggregate
- snapshot recursion follows the configured structure without a fixed depth limit
- `snapshot()` returns enabled scalar values plus folder structs
- `get_priority_keys()` returns the union of all client priority sets

## WebSocket Flow

`backend/services/websocket_manager.py` batches pending variable updates into 50 ms windows. On connect it accepts the socket, sends an empty `var_snapshot`, then streams cached values in `var_update` chunks. On disconnect the client is removed from the connection map, its priority keys are cleared, and datasource subscription priority is recomputed.

The full handshake order, every message shape, and the async-action result correlation (`requestId` → `write_response` / `write_error`, reason-code vocabulary, client-synthesised `timeout` / `disconnected`) are specified in [websocket.md](websocket.md).

## Priority Subscriptions

Priority keys are grouped by datasource and forwarded to the matching OPC-UA engine.

Current frontend producers:

- `HmiView` sends `set_context` with active runtime page/dialog/overlay-page context
- `PreviewView` sends `set_context` with preview page/dialog context
- `DatasourceVariableTable` sends `set_context` with explicit `priorityKeys`

`set_context` payload currently supports:

- `currentPageIds` (overlay pages included — there is no separate key)
- `openDialogIds`
- `priorityKeys`

## REST Surface

The project instance mounts the config, datasource, alarm, widget, theme,
system, users, historian, and recipe route groups. The complete
endpoint reference — paths, request/response shapes, and which routes live on the
manager vs a project instance — is in [../reference/rest-api.md](../reference/rest-api.md).

## Static Serving

The backend mounts these static routes in `main.py`:

- `/widgets` -> `<live-project>/custom-widgets/` (CSS, fonts)
- `/widget-js` -> `<runtime_home>/.widget-build/` (compiled JS, build artifacts)
- `/external-libraries` -> `<live-project>/external-libraries/`
- `/assets` -> `<live-project>/assets/`

The `/widget-js` route serves compiled `index.js`. Build status is read from `<runtime_home>/.widget-build/.build-status.json` by the widgets listing API.

Mounts are registered at module-import time against the project this instance is pinned to. Because each project runs in its own process, serving a different project is a matter of the supervisor starting another instance — not switching mounts inside a live process.

## Health And Restart

- `GET /api/health` is a basic liveness check
- `POST /api/system/restart` writes `<runtime_home>/.restart-pending`, broadcasts `{type: "restarting", reason}` to every `/ws` client, then raises `SIGTERM` so uvicorn's lifespan teardown runs cleanly. A grace timer hard-exits if shutdown stalls. In **manager mode** the launcher sees the sentinel and re-execs a fresh interpreter so device-level static mounts re-resolve. A **managed instance** that exits is simply respawned by the supervisor — it never owns the re-exec loop (crash recovery is the supervisor's job).

## Alarm Engine

`alarm_manager` builds a `{composite_var_key → [(definition, group)]}` trigger map from the alarm config. On every variable change reported by `datasource_manager`, the manager:

1. looks up matching alarm definitions by composite key
2. extracts the array element value if the trigger binding includes an `index`
3. evaluates `bool` (compare to `on_true`) or `value_range` (`min`/`max` thresholds, both can be plain numbers, `$static`, or `$var`) trigger
4. fires a new `AlarmInstance` if the trigger transitions from inactive → active
5. clears the active instance and writes a `AlarmHistoryEntry` (capped at 500 entries) on the reverse transition
6. persists `alarm_state.json` and broadcasts `alarm_update` to all clients

`get_trigger_paths_by_datasource()` is consumed by the websocket manager to keep alarm-trigger variables permanently on the priority OPC-UA subscription.

## Widget Storage

Reusable components are individual JSON files under `active_components_dir()` (the live project's `components/`). A reusable component may use `$componentProp`, but it may not own a `$var` source anywhere below a child widget or a `componentProperties[*].defaultValue`. This rule is recursive through objects, lists, and mixed expression wrappers. Component create/update, build diagnostics, persisted-component reads, and every project archive import/push/pull use the same scanner. Rejections and diagnostics expose the exact escaped RFC 6901 source path ending in `/$var` (for example `/children/0/properties/text/$if/true/$var`); diagnostic `propKey` and `fieldPath` values are unescaped so editor fields containing `/` or `~` still attach correctly. Existing files are scanned before any component metadata migration. Binding-invalid files stay byte-for-byte unchanged, while malformed JSON, invalid UTF-8, unreadable files, and a non-directory `components` path fail closed with a stable `components/<file>.json#/: <reason>` error. The scanner rejects the `components` root, every descendant directory, and every candidate component file when it is a symlink or Windows reparse point. Files are opened no-follow where the platform supports it and checked by pre-open, opened-handle, and post-open identity before reading. Every mutation then uses `core/component_storage.py` rather than ordinary path writes. POSIX retains no-follow root/group directory descriptors and performs temp creation, write, fsync, replace, unlink, mkdir, and recursive removal relative to those descriptors. Windows pins the root and relevant directories with `CreateFileW(OPEN_REPARSE_POINT | BACKUP_SEMANTICS)` while omitting `FILE_SHARE_DELETE`; recursive deletion marks pinned leaf/directory handles with `FileDispositionInfoEx` (safe `FileDispositionInfo` fallback) before closing them. Missing platform primitives fail the operation closed. Metadata migration uses cached scan data, so post-validation root, group, or file swaps cannot redirect reads or writes outside the originally bound component tree. Imported projects are rejected and cleaned up before registration, including push and pull staging. The `project-seed` data here and the `project-testbench` data in the private dev/test repository were both scanned before enforcement and required no component-data changes. Nested reusable components remain prohibited, and names must be unique across all reusable components.

Two component rules are advisory rather than blocking, both reported by `POST /api/config/validate`:

- `componentprop-nested` — a `$componentProp` that is not a property's whole value (nested in another source, or on a non-`properties` key such as `layout`). Only the bare `{"$componentProp": "<key>"}` shape is substituted before render, so anything else resolves once and stops updating. Detected by `component_nested_prop_paths()` in `core/component_validation.py`, which walks the definition's tree node-aware (position matters) and its `componentProperties[*].defaultValue` as bare values.
- `slot-unknown` / `slot-empty` — a `$component:` instance's child naming a slot the definition does not declare, or an empty slot name. Warnings, not errors: such a child still renders in the definition's first slot, so trimming a definition must not take the pages using it down with it. A child on a component that declares no slots renders nowhere and gets `slot-unknown` on the `children` array itself. `build_context()` collects each component's slot names by walking its tree for `ComponentSlot` nodes (`_collect_component_interfaces()`, fingerprint-cached alongside the declared property names).
- `slot-property-unmatched` — a definition declaring a `widgets` component property that no `ComponentSlot` names. The property is the declared name of a slot, so without the widget it promises a slot the definition cannot render and the editor shows no row for it. A warning, not an error: declaring the property before placing the widget is the natural authoring order. `component_slot_property_gaps()` in `core/validation/structure.py`, reported from `_validate_component_tree()`.
- `slot-undeclared` — the reverse half: a `ComponentSlot` whose name matches no `widgets` property. The slot still renders, but no instance gets a panel row for it, so it is reachable only from the widget tree. `component_undeclared_slots()`, same call site. A blank slot name falls back to `content` and is reported under that name.

## Validation Warnings vs Errors

`core/validation/report.py` splits findings into two buckets — `findings` (errors, block the write) and `warnings` (advisory, returned to the caller but not blocking).

Errors still 422 with `to_message()` describing the head finding + count. Warnings are surfaced two ways:

- `GET /api/config/validate` returns advisory and blocking diagnostics for the persisted project. Realtime editor diagnostics use `POST /api/config/validate`; page/config write responses do not embed warning arrays.
- MCP page-mutation tools (`pages_add_widget`, `pages_set_widget_property`, `pages_set_metadata`, `pages_delete_widget`) include the warnings array on their `applied_response`.

Current downgrades (was 422, now warning): empty `$var.datasource`, empty `$var.path`, unknown datasource, unknown variable. Structural corruption (non-object `$var` payload) stays a hard error. Rationale: the editor produces empty bindings transiently while the user picks a datasource; the registry can grow at runtime (late OPC-UA pools, project imports); the frontend resolver returns null for unresolved bindings.

## Project Export Filtering

`core/project_packer.py` excludes generated state from project zips. Two layers:

- `_SKIP_TOPLEVEL` — directories never descended (`widget-build`, `.widget-build`).
- `_HISTORIAN_LOCAL_SUFFIXES` — file suffixes stripped only inside `historian/` (`.db`, `.db-wal`, `.db-shm`, `.sqlite`, `.sqlite-journal`). The Historian `config.json` still ships — receivers need to know which variables to log, what retention to apply — but the on-disk database doesn't.

## LAN Peer Transfer

See [reference/peer-transfer.md](../reference/peer-transfer.md) — trust
model, staging/atomic-commit/journaling/reconciliation, collision policies,
and the Windows weaker-guarantee note all live there now.

Export and import (`projects_api.py`) share the same zip code path
(`core/project_packer.py`) as manager peer transfer. There is no unauthenticated
push/pull surface anywhere in the backend — every peer-to-peer path requires
the manager's device-admin pairing.

## Current Constraints

- custom-component discovery depends on files existing under `<live-project>/custom-widgets/`
- language add/remove endpoints are hard-wired to `Default.csv`
- WebSocket writes are handled through `write_field`; unknown client message types are ignored
- alarm history is capped at 500 entries (oldest dropped)
- static mounts (`/widgets`, `/widget-js`, `/external-libraries`, `/assets`) are bound to the pinned project at import time; serving a different project means the supervisor running another instance, not a mount switch
- mDNS peer discovery degrades gracefully (manual entry still works) when `zeroconf` isn't installed or the network blocks multicast
