# NEXT HMI API Reference

This document reflects the routes and WebSocket messages implemented in the current codebase (see `backend/main.py` for router wiring and `backend/api/*.py` for endpoint definitions).

All responses are JSON unless noted. Domain errors are mapped by `core/exceptions.py`:

- `NotFoundError` → `404 { "detail": "<message>" }`
- `ConflictError` → `409 { "detail": "<message>" }`
- `ValidationError` → `422 { "detail": "<message>" }`
- `RateLimitError` → `429 { "detail": "<message>" }`

Routes split across **two apps**: the **manager** (`backend/manager.py`, default port `8000`) owns `/api/manager/*` and the project list, and reverse-proxies `/runtime/<slug>/*` and `/editor/<slug>/*` to a project instance. A **project instance** (`backend/main.py`) owns the config/datasource/alarm/widget/WebSocket surface below — reached at the origin root in dev/direct-uvicorn, or under `/runtime/<slug>/` (or `/editor/<slug>/`) through the manager proxy. Endpoints are marked **(manager)** where they live only on the manager app.

A few endpoints raise `fastapi.HTTPException` directly with other status codes — those are called out per endpoint.

## Authentication

The **manager** front door is gated by a single **device-admin password** set on first run. The manager's `_auth_gate` middleware requires a valid session cookie (`nexthmi_manager_session`, a stateless HMAC-signed token) on every `/api/*`, `/runtime/*`, and `/editor/*` request, except `/api/manager/auth/*`, `/api/manager/peer/*`, and `/api/health`. Peer endpoints perform their own bearer-token authentication (only pairing accepts the existing device-admin password). The same cookie authorizes the `/runtime/<slug>/ws` and `/editor/<slug>/ws` proxy. See **Manager API** below for the login/setup endpoints; the password digest lives in `<runtime_home>/.manager-auth.json`.

A **project instance's** own HTTP API and WebSocket are unauthenticated — instances bind `127.0.0.1` and are only reachable through the manager proxy (which strips the manager cookie before forwarding). Running an instance directly (dev / `uvicorn main:app`) exposes it unauthenticated, so bind a trusted interface in that case.

## Health

- `GET /api/health` → `{ "status": "ok" }`

## Static mounts

- `/widgets/*` — files under `<live-project>/custom-widgets/` (component CSS, fonts, etc.)
- `/widget-js/*` — files under `<runtime_home>/.widget-build/` (compiled custom-component bundles)
- `/assets/*` — files under `<live-project>/assets/` (icons, images)
- `/external-libraries/*` — files under `<live-project>/external-libraries/` (third-party bundles a custom widget loads)

These are FastAPI `StaticFiles` mounts and serve any file in the named directory.

## Documentation

- `GET /help` **(manager)**
  - Serves the rendered user guide. A build with docs bundled beside the executable mounts them as static files at `/help/`; a source checkout or the Docker image has no bundled copy, so the route redirects to `PUBLIC_DOCS_URL` (`https://next-hmi.com/docs/`) instead. Only `docs/user/` is ever rendered. Not `/docs` — that is FastAPI's Swagger UI.

---

## Config API

Base prefix: `/api/config`. Page index, shared shell areas, dialogs, dictionaries and translations all live here.

### Global config (page index + shared areas)

- `GET /api/config/config`
  - Returns the hydrated config document. Per-page metadata is merged in from each page file:

    ```json
    {
      "version": 2,
      "pages": [
        { "id": "home", "type": "page", "title": "...", "icon": "...", "sections": { "content": [] } },
        { "id": "machines", "type": "page-group", "header": [], "footer": [], "children": [ ... ] }
      ],
      "header": [],
      "footer": [],
      "leftSidebar": [],
      "rightSidebar": [],
      "shell": {},
      "dialogs": [],
      "globalEvents": {}
    }
    ```

  - `globalEvents` is an object keyed by lifecycle event name; each value is an array of action objects.

- `PUT /api/config/config`
  - Body must contain a `pages` array; `header`, `footer`, `leftSidebar`, `rightSidebar`, `shell`, `dialogs`, `globalEvents` are accepted optionally.
  - Index validation rules (`422` on failure):
    - Each entry must be an object with a string `id`.
    - IDs must be unique across the entire (recursive) index.
    - `type` must be `"page"`, `"page-group"`, or omitted.
    - Page entries must not embed page content (`children` / `sections`) — that lives in the per-page file. Use `PUT /api/config/pages/{id}`.
    - Group entries must have a `children` array; optional `header` / `footer` arrays are allowed.
  - On save the index is normalized: groups keep their metadata; page entries are reduced to `{ id, type: "page" }` (metadata for pages is stored in the per-page file).
  - Orphaned page files (id no longer in the index, excluding `__*.json`) are deleted.
  - Returns the normalized payload.

### Per-page content

- `GET /api/config/pages/{page_id}`
  - Returns the full page document. If the file is missing returns `{ "id": page_id, "sections": { "content": [] } }`.
  - `422` if `page_id` doesn't match `[A-Za-z0-9_-]{1,128}`.
- `PUT /api/config/pages/{page_id}`
  - Body is merged into the persisted file; only these keys are kept on disk:
    `title`, `icon`, `description`, `breadcrumbLabel`, `hidden`, `role`, `order`, `showHeader`, `showFooter`, `shellOverride`, `sections`.
  - `sections` (when supplied) must be an object whose values are arrays. Pages may not contain `type: "page-group"` nodes — nest a group inside another group instead (`422`).
  - Returns the merged document `{ id, ...persisted fields, warnings: [{path, message}] }`. `warnings` is the validator's advisory bucket (incomplete `$var` bindings, unknown datasources/variables) — non-blocking and surfaced by the editor as "Saved · N warnings". Hard errors still 422.
  - `422` if `page_id` is invalid.
- `DELETE /api/config/pages/{page_id}`
  - Removes the page file if present. Returns `{ "ok": true }`.
  - `422` if `page_id` is invalid.

### Validation

Both endpoints are read-only: they never persist, recompile, or rewrite anything. Findings share one row shape:

```json
{
  "artifactId": "home", "artifactKind": "page", "sourcePath": "/sections/content/0/properties/text/$var",
  "widgetId": "w-3", "propKey": "text", "fieldPath": ["path"],
  "code": "unknown-variable", "severity": "error", "message": "...",
  "breadcrumb": "Boiler > Text > text", "nested": false
}
```

`sourcePath` is a JSON Pointer into the posted draft; `widgetId` / `propKey` / `breadcrumb` are recovered by walking that pointer against the tree, so the same shape works for every artifact kind. `nested` marks a finding inside a sub-slot of a property (an `$if` condition, say) rather than on the property's own value.

- `POST /api/config/validate`
  - Body: `{ "kind": "page" | "dialog" | "shell" | "globalEvents" | "component", "draft": { ... } }`.
  - Validates the posted *unsaved* draft, so it covers edits the editor hasn't saved. Disk is read only for context (widget registry, translations, assets).
  - `422` when `kind` is not one of the five, or `draft` is not an object.
  - Returns `{ "diagnostics": [ ... ] }`.
- `GET /api/config/validate`
  - Whole-project sweep from disk: shell areas, every dialog, `globalEvents`, every page file, reusable components, translation dictionaries, and custom-widget build status — everything the realtime endpoint never sees because only one artifact is open at a time.
  - Returns `{ "diagnostics": [ ... ] }` in the same row shape. This is what the editor's Diagnostics panel lists.

### Dictionaries

- `GET /api/config/dictionaries`
  - Returns `[{ name, filename }]` for every CSV under `<live-project>/translations/`. `Default` is always first.
- `POST /api/config/dictionaries`
  - Body: `{ "name": "MyDictionary" }`
  - Validation: name must match `[A-Za-z0-9_\- ]`, length ≤ 64.
  - `422` if name missing/invalid; `409` if a CSV with that name already exists, or if name is `Default`.
  - Copies the language header row from `Default.csv` when present, otherwise creates `["en-EN"]`.
  - Returns the updated dictionary list.
- `DELETE /api/config/dictionaries/{name}`
  - `Default` cannot be deleted (`422`). Invalid name → `422`. Missing file → `404`.
  - Returns the updated dictionary list.

### Translations

All translation endpoints take a `?dict=<name>` query (default `Default`). The CSV file is laid out as: row 0 = language codes, rows 1+ = translation rows. Column 0 is both the primary-language value and immutable lookup key; there is no separate ID or migration format.

- `GET /api/config/translations?dict=Default`
  - Returns `{ languages: [{ code }], rows: { [key]: { [code]: value } }, revision }`. `revision` is a stable hash of the current CSV bytes (`"missing"` when absent).
  - Missing cells are returned as `""`. Empty/duplicate keys, duplicate/empty language codes, and row cells beyond the header are rejected instead of being returned with data loss.
  - An existing zero-byte CSV is malformed (`422`); an absent CSV remains a separate empty/missing result.
- `POST /api/config/translations?dict=Default`
  - Body: `{ "key": "MyKey" }`.
  - `422` if key missing; `409` if the key already exists.
  - Appends a row with empty values for the other language columns.
  - Returns the full translations document.
- `PUT /api/config/translations?dict=Default`
  - Body: `{ "languages": [{ "code": "en-EN" }, ...], "rows": { "key": { "en-EN": "...", "nl-NL": "..." } }, "revision": "<revision from GET or the last mutation>" }`
  - Atomically updates the document; missing secondary values are written as `""`.
  - Missing or stale revisions return `409`; the stored CSV is unchanged. This prevents a stale editor save from overwriting REST, MCP, or language-column changes made since it loaded.
  - For an existing dictionary, the first language code and exact key set must remain unchanged. A primary-language value must equal its row key. Secondary columns may be added, removed, or reordered and their values remain editable. Use `POST`/`DELETE` for row creation/deletion.
- `DELETE /api/config/translations/{key}?dict=Default`
  - The path supports `/` in `key` (`{key:path}` matcher). Returns `404` if the file or the key is missing.
  - Translation mutation responses return the same full document shape, including its new `revision`.

### Languages

These endpoints take the same validated `?dict=<name>` query (default `Default`) and mutate only the selected dictionary.

- `POST /api/config/translations/language?dict=Custom`
  - Body: `{ "code": "fr-FR" }`.
  - `422` if code missing; `409` if the language already exists.
  - Adds a new column to the selected CSV (existing rows get an empty cell).
- `DELETE /api/config/translations/language/{code}?dict=Custom`
  - `404` if the file is missing or the code is not present. `422` if you try to remove the first column.
  - Removes the column from every row.

---

## Datasource API

Base prefix: `/api/datasources`. Datasource types supported (`models/datasource.py`): `opcua-client`, `static`, `opcua-test-server`.

### CRUD

- `GET /api/datasources`
  - Returns summary items shaped as
    `{ name, type, connected, variable_count, enabled_count, error }`.
  - `connected` is filled from the OPC-UA pool for `opcua-client` entries and from the test-server pool for `opcua-test-server` entries.
  - `error` is a user-facing reason the datasource is not running (or `null`). For an `opcua-test-server` it carries the start failure — e.g. a port already in use — captured when the server can't bind; the editor shows it as an error status dot + message instead of the backend aborting startup.
- `GET /api/datasources/{name}`
  - Returns the full datasource config (settings + variables).
  - Query: `include_variables=true|false` (default `true`). When `false`, the `variables` key is stripped from the response.
  - `404` if the datasource doesn't exist.
- `PUT /api/datasources/{name}`
  - Upserts a datasource. Body shape (`DatasourceUpsertBody`):

    ```json
    {
      "type": "opcua-client | static | opcua-test-server",
      "settings": { ... },
      "variables": [ ... ],
      "...extra fields...": "kept as-is (model extras allowed, e.g. certs, ports)"
    }
    ```

  - Stored payload always includes `"name": <name>` so the on-disk file is self-identifying.
  - Runtime sync after save:
    - `opcua-client` — starts (new) or restarts (existing) the pool engine.
    - `opcua-test-server` — starts (new) or restarts (existing) the test-server instance.
    - `static` — no runtime engine.
- `DELETE /api/datasources/{name}`
  - Stops the OPC-UA engine and any paired test server, broadcasts `var_removed` for previously enabled variables and folder paths, deletes the config.
  - `404` if missing. Returns `{ "status": "deleted" }`.

### Variable tree

- `GET /api/datasources/{name}/variables`
  - Returns `{ "variables": [...] }`. `404` if the datasource is missing.
- `PUT /api/datasources/{name}/variables`
  - Body is the new `variables` array (replaces only the variable tree).
  - Computes the enabled-path delta:
    - For `opcua-client`: subscribes new paths and unsubscribes removed ones on the live engine; evicts cached values for unsubscribed paths.
    - For `opcua-test-server`: updates writable flags on the live sim loop.
    - Broadcasts `var_removed` for removed enabled paths.
  - Returns the variables array as written.

### Write

- `POST /api/datasources/write`
  - Requires HTTP Basic credentials for a user in the active project's `users.json`; manager-session authentication is not accepted as a substitute for an HMI identity.
  - Body uses the WebSocket write envelope: `{ "datasource": "PLC", "path": "Motor/Speed", "value": 42, "field"?: "name" }`.
  - Returns `{ "ok": true, "reason": null }` or `{ "ok": false, "reason": "<stable reason>" }`; invalid credentials return HTTP `401`.
  - Uses the same envelope parser, `interactableByGroups` authorization, coercion matrix, and write service as WebSocket `write_field`. Present `null` reaches coercion and returns `invalid_value`; missing or malformed envelope fields return `bad_request`.

### Connection wizard

Pre-save helpers. None of them touch the live pool or persist a datasource.

- `POST /api/datasources/discover`
  - Body: `{ "address": "opc.tcp://host:4840" }`. Enumerates the server's endpoints so the engineer can pick one instead of typing URL/security/auth by hand.
  - Returns `{ ok, error, endpoints: [{ endpoint_url, security_mode, security_policy, user_tokens, server_name, application_uri }] }`. A failed probe is `ok: false` with `error`, not an HTTP error.
- `POST /api/datasources/test-connection`
  - Body: `{ server_url, username?, password?, security_policy?, security_mode?, ...extra }`. Extra fields (certificate paths, key password) are forwarded to the probe unchanged.
  - Opens a throwaway session. Returns `{ ok, error, server_name, namespace_count }`.
- `POST /api/datasources/certs`
  - Multipart: `file`. Called once per file in the secure-connection step (client certificate, private key, server certificate) — never for the key password, which stays a plain settings field.
  - Stores the upload under `<live-project>/certs/` with a sanitized filename and returns `{ "path": "certs/<filename>" }`, the value the caller stores in `client_certificate` / `client_private_key` / `server_certificate`. A filename that would escape the certs folder is `422`.

### Browse

- `GET /api/datasources/{name}/browse`
  - Only valid for `opcua-client` and `opcua-test-server` (`422` for `static`).
  - Returns the engine's `browse()` result (the OPC-UA node tree).
  - `503` if the OPC-UA pool is unavailable, no engine exists for the datasource, or the engine is not connected.

### Lifecycle

- `POST /api/datasources/{name}/start`
  - `opcua-test-server` → starts the test server (`{ "status": "started" }`).
  - `opcua-client` → reconnects the client (`{ "status": "reconnecting" }`).
  - `422` for `static`.
- `POST /api/datasources/{name}/stop`
  - Only valid for `opcua-test-server` (`422` otherwise). Returns `{ "status": "stopped" }`.
- `POST /api/datasources/{name}/restart`
  - `opcua-test-server` → restarts (`{ "status": "restarted" }`).
  - `opcua-client` → reconnects (`{ "status": "reconnecting" }`).
  - `422` for `static`.

`503` is returned from any lifecycle/browse endpoint when the corresponding pool was not wired into the API at startup.

---

## Alarm API

Base prefix: `/api/alarms`. Configuration models live in `models/alarm.py`; runtime state is owned by `alarm_manager`.

### Configuration

- `GET /api/alarms/config` → `AlarmConfig` `{ version, groups: [{ id, title, alarms: [AlarmDefinition] }] }`.
- `PUT /api/alarms/config`
  - Body must satisfy `AlarmConfig`. Replaces the whole document.
  - Triggers a rebuild of the trigger map and re-prioritises trigger variables on the OPC-UA subscription.

### Runtime state

- `GET /api/alarms/active` → `AlarmInstance[]` (currently active instances, oldest first).
- `GET /api/alarms/history?limit=100&offset=0` → `AlarmHistoryEntry[]`, newest first.
  - `limit` is clamped to `[1, 1000]`; `offset` must be `>= 0`. Out-of-range values yield FastAPI's `422`.
- `GET /api/alarms/summary` → `AlarmSummary` `{ total, unacked, error_count, warning_count, info_count }`.

### Acknowledgement

- `POST /api/alarms/ack/{instance_id}`
  - Body: `{ "username": "<non-empty>" }`.
  - `422` if `username` is empty; `404` if the instance is not in the active list.
  - On success the alarm is marked `acked = true`; it remains active until its trigger clears. Returns `{ "status": "ok" }` and triggers an `alarm_update` broadcast.
- `POST /api/alarms/ack-all`
  - Body: `{ "username": "<non-empty>" }`.
  - Acks every currently unacked active instance. Returns `{ "status": "ok", "count": <n> }`.

---

## Recipe API

Base prefix: `/api/recipes`. Config models live in `models/recipe.py`; state and download/upload are owned by `recipe_manager`, which writes through the shared `write_service`.

A project defines **dataset types** (independent axes). Each type owns **parameters** (each binds a writable variable + data type) and **saved datasets** (named value sets, one value per parameter). One dataset can be loaded per type at a time.

### Configuration

- `GET /api/recipes/config` → `RecipeConfig` `{ version, datasetTypes: [{ id, name, parameters: [RecipeParameter], datasets: [RecipeDataset] }] }`.
- `PUT /api/recipes/config`
  - Body must satisfy `RecipeConfig`. Replaces the whole document, backfills slug ids, re-prioritises parameter variables on the OPC-UA subscription, and broadcasts `recipe_update`.

### Runtime state

- `GET /api/recipes/state` → `{ loaded: { <datasetTypeId>: { datasetId, loadedAt } } }` — the dataset loaded per type.

### Download / upload

- `POST /api/recipes/datasets/{id}/download`
  - Body: `{ "verify"?: bool }`. Writes every parameter's stored value to its variable (continue-on-error). With `verify`, each value is read back and confirmed by exact match. Records the dataset as loaded for its type on success/partial.
  - `404` if the dataset id is unknown. Returns `DownloadResult` `{ result: success|partial|failed, datasetId, written, total, verified, failures: [{ parameterId, reason }] }`.
- `POST /api/recipes/datasets/{id}/upload`
  - Reads current live values and overwrites the dataset's `values` in place. `404` if unknown. Returns the updated `RecipeConfig`.

The WebSocket `recipe_load` / `recipe_save` messages (see `architecture/websocket.md`) drive the same manager methods for button-bound `recipeLoad` / `recipeSave` actions that need `$result`.

---

## Reusable Component API

Base prefix: `/api/components`. These endpoints manage reusable components (named widget compositions with input properties), stored as `<live-project>/components/<group?>/<id>.json`. The API exposes `id` and `group`, but both are derived from that path and are not duplicated inside the JSON document.

- `GET /api/components` → `ComponentDefinition[]`.
- `GET /api/components/{component_id}` → `ComponentDefinition` (`404` if missing).
- `POST /api/components`
  - Body: full `ComponentDefinition`. The server derives a unique slug `id` from `name`; a supplied body `id` is ignored.
  - `409` on duplicate `name`. `422` if the children tree or any `componentProperties[*].defaultValue` contains a `$var` at any nesting depth, or if a nested `$component:<id>` type appears in `children`. A direct-binding error includes the exact JSON source path ending in `/$var`.
- `PUT /api/components/{component_id}`
  - Same validation as create. `404` if the id does not exist. The path id always wins (the body's `id` is overwritten on save).
- `DELETE /api/components/{component_id}`
  - `404` if missing. Returns `{ "status": "ok" }`.
- `GET /api/components/folders` → `string[]` — every component folder path, any depth (including empty folders), `/`-joined (e.g. `"A/B/C"`).
- `POST /api/components/folders`
  - Body: `{ name }`, a `/`-joined path. Creates the folder and any missing intermediate folders in one call.
- `DELETE /api/components/folders/{folder_path:path}`
  - Deletes the folder and everything inside it — subfolders and components alike. `folder_path` may itself be a `/`-joined nested path.

### `ComponentDefinition` shape

```json
{
  "id": "uuid",
  "name": "MyWidget",
  "group": "Process/Overview",
  "description": "Shows the current process state.",
  "category": "Process",
  "icon": { "type": "builtin", "name": "gauge" },
  "componentProperties": {
    "label": {
      "type": "string",
      "label": "Label",
      "description": "Shown under the field in the properties panel.",
      "defaultValue": "",
      "structSchema": [],
      "write": false,
      "options": [],
      "display": null,
      "placeholder": null,
      "min": null,
      "max": null,
      "step": null
    }
  },
  "children": [
    { "type": "Text", "properties": { "text": { "$componentProp": "label" } } }
  ]
}
```

Allowed `componentProperties[*].type` values: `string`, `number`, `boolean`, `color`, `url`, `icon`, `image`, `struct`, `select`, `actions`. `description` is optional and mirrors `SchemaField.description` on the frontend. Extra keys at any level are rejected (`extra="forbid"`).

A child of a `$component:` node inside `children` may carry a `slot` string naming which of the definition's slots it fills — see [Component slots](../architecture/data-formats.md#component-slots).

### Widget schema manifest

- `GET /api/widget-schemas` → manifest produced by the backend widget compiler.
  Built-in and custom entries use the same catalog metadata shape:
  ```json
  {
    "version": 2,
    "builtin": { "Container": { "name": "Container", "category": "Layout & structure", "description": "...", "icon": { "type": "builtin", "name": "stack" }, "schema": { ... } } },
    "custom":  { "<SourceFolder>/<Name>": { "name": "...", "category": "...", "description": "...", "icon": { "type": "builtin", "name": "..." }, "schema": { ... }, "exportedProperties": [ { "key": "value", "label": "Value", "type": "float" } ] } }
  }
  ```
  `description`, `icon` and `exportedProperties` are optional. A custom entry
  whose exports could not be reduced to literals carries `schemaError` (the
  extractor's message) and an empty `schema` instead; the rest of the manifest
  is written normally. The shipped stdlib widgets are overlaid onto `builtin`,
  so a runtime home that has never compiled still answers with them; `404` means
  both maps are empty — nothing built at all.
  Consumers must accept unknown top-level keys for forward compatibility.

---

## Components and Assets API

These endpoints expose what's in the user workspace directly (no `/api` prefix on the router; the routes do).

- `GET /api/widgets`
  - Scans `<live-project>/custom-widgets/` (skipping folders that start with `.` or `_`).
  - Supports both layouts:
    - Flat: `<Name>/index.tsx` → `group: null`.
    - Grouped: `<Group>/<Name>/index.tsx` → `group: "<Group>"`.
  - Returns `[{ key, name, group, hasStyle, hasFonts, buildOk, buildError, buildTs, category, description, icon, schema, exportedProperties, schemaError }]`.
  - `key` is the normalized project-relative widget path (`<Name>` or `<Group>/<Name>`). `buildOk` / `buildError` / `buildTs` come from that key in `<runtime_home>/.widget-build/.build-status.json`.
  - `category`, `description`, `icon`, `schema` and `exportedProperties` are read from the compiled `<runtime_home>/.widget-build/widget-schemas.json` (`null` when the widget has never compiled). They let the client register a widget — schema, drawer card, `$widgetProp` list — without importing its module, which is what makes the modules load lazily on first render instead of all at once at startup.
  - `schemaError` is set when the widget compiled but the schema extractor could not reduce its exports to literals. The widget still renders; the editor offers no property fields and no `$widgetProp`s for it. Every other widget keeps its schema — one unreadable widget no longer costs the whole manifest.
- `POST /api/widgets/recompile`
  - Recompiles every custom widget and regenerates the schema manifest. Broadcasts a `widget_updated` event per widget so open browsers reload the module.
  - Returns the refreshed list in the `GET /api/widgets` shape.
- `POST /api/widgets/recompile/{key:path}`
  - Recompiles one widget by registry `key` (flat `<Name>` or grouped `<Group>/<Name>`). Same response shape.
  - `404` for an unknown key, and for a raw path containing a percent-escape — the key is matched against the undecoded path so an encoded traversal cannot resolve.
- `GET /api/assets`
  - Lists files from `<live-project>/assets/icons` (`.svg` only) and `<live-project>/assets/images` (`.png`, `.webp`, `.jpg`, `.jpeg`, `.gif`, `.svg`), recursing into subfolders.
  - Returns `[{ name, path, type: "icon" | "image", mime, size }]`. `path` is relative to the assets root and can be served via `/assets/{path}`.

---

## Device API

- `GET /api/device/info`
  - Best-effort identification of the HTTP client making the request.
  - Reads `X-Forwarded-For` (first hop) or `request.client.host`; strips `::ffff:` IPv6-mapped prefixes.
  - Hostname is resolved via reverse-DNS (`socket.gethostbyaddr`).
  - MAC is resolved from `/proc/net/arp` on Linux, otherwise from `arp -n <ip>` (1 s timeout). Returns `null` for any value that can't be determined.
  - Response: `{ "ip": string | null, "hostname": string | null, "mac": string | null }`.

---

## Users API

Base prefix: `/api/users`. IDs (user id, group id, username) must match `[A-Za-z0-9_-]+` and be ≤ 64 chars.

- `GET /api/users` → full users document `{ settings, groups, users }`, with every
  stored password redacted to `""`, no `passwordHash`, and a boolean
  `passwordSet` per user.
- `PUT /api/users`
  - Body: the complete `{ settings, groups, users }` document returned by `GET /api/users`.
  - Validates all sections and their group references before atomically replacing `users.json`; validation failure leaves the stored document unchanged.
  - Preserves unchanged stored credentials without exposing them. A non-empty
    submitted password is stored in the server-managed `passwordHash` object
    `{ version, algorithm, iterations, salt, digest }`, with `password: ""`.
    Clients may never submit `passwordHash` directly.
  - Legacy `password` strings remain literal plaintext regardless of their
    prefix, and the exact credential value is preserved by an unchanged save.
  - The canonical `guest` user is required, must keep both id and username
    `guest`, must belong only to the `guest` group, and cannot have credentials.
- `PUT /api/users/settings`
  - Body: `{ "autoLoginName": "guest", "configAccessGroups": ["admin", ...] }`.
  - `422` if shapes are wrong or if `configAccessGroups` references unknown group IDs.
  - Returns the persisted `settings`.
- `PUT /api/users/groups`
  - Body: array of `{ id, label? }`. `id` must be valid; `label` defaults to `id`.
  - `422` on invalid id, missing `guest` group, non-list body, or references that
    would be left dangling. `409` on duplicate ids.
  - Returns the persisted groups list.
- `DELETE /api/users/groups/{group_id}`
  - `422` for `guest` or a referenced group; `404` if not found. Returns `{ "deleted": group_id }`.
- `PUT /api/users/users`
  - Body: array of `{ id, username, password, groups: [groupId, ...] }`.
  - `422` on invalid id/username, missing `guest` user, or zero-group user. `409` on duplicate id / username.
  - Applies the same canonical-guest, group-reference, password hashing, hash-injection rejection, and redaction rules as the full-document endpoint.
  - Returns the redacted persisted users list.
- `DELETE /api/users/users/{user_id}`
  - `422` for `guest`; `404` if not found. Returns `{ "deleted": user_id }`.

---

## MCP API

Manager-side control surface for the workspace MCP endpoint (`/mcp`).

### MCP enablement (per project)

MCP is a single workspace endpoint on the **manager** (`/mcp`); the per-project
`mcpEnabled` flag is the authorization scope it enforces (writes refused when
off). Its control surface is the manager dashboard.

**(manager)**

- `GET /api/projects/{id}/mcp` → `{ id, mcpEnabled }`.
- `POST /api/projects/{id}/mcp` — body `{ "enabled": bool }`. Persists
  `mcpEnabled` to that project's `config.json`; works whether the project is
  running or stopped. The projects list (`GET /api/projects`) also reports
  `mcpEnabled` per entry.

### MCP bearer tokens

**(manager)** Long-lived credentials for headless AI clients hitting `/mcp`.

- `POST /api/manager/mcp/pair` — body `{ password, projectId, access, name? }` where `password` is the device-admin password and `access` is `"read"` or `"write"`. → `201 { tokenId, token, projectId, access, transport, trustedLanOnly }`. The plaintext `token` is returned once; only its SHA-256 digest is persisted (`<runtime_home>/.mcp-tokens.json`). Reachable **pre-session** (like login/setup) because a pairing client has no session cookie yet, and therefore subject to the same login throttle — `429 RateLimitError` after 5 failures. Unknown `projectId` → `404`.
- `GET /api/manager/mcp-tokens` → `{ tokens: [{ id, name, projectId, access, createdAt }] }` (no secrets).
- `DELETE /api/manager/mcp-tokens/{id}` → `{ revoked: true, tokenId }`; `404` when the id is unknown.

A token is scoped to exactly one project and one access level, re-checked per tool call. Changing the device-admin password revokes every issued token.

---

## Enterprise edition

This repository builds one edition — `oss`, the AGPL artifact — and it serves
no `/api/admin/*` routes at all: no license check, no license storage, no
machine fingerprinting.

The `ee` build (`NEXTHMI_EDITION=ee`) mounts additional routers on top of the
same core app, among them the device-license and machine-id routes earlier
revisions of this file documented. That code is not in this repository, so
neither are its endpoint shapes — they are documented next to the
implementation, which keeps this reference verifiable against the source beside
it. See [Edition seam](../architecture/backend.md#edition-seam).

---

## System API

Base prefix: `/api/system`.

- `GET /api/system/info`
  - `{ "uptime_seconds": int, "python": "3.x.y", "pid": int }`.
- `GET /api/system/subscriptions`
  - Returns the OPC-UA pool's fast-subscription state, keyed by datasource name.
  - `opcua-test-server` entries (the back-side of a paired test server + client) are filtered out.
- `GET /api/system/alarm-triggers`
  - Returns `{ <datasource_name>: ["<path1>", ...] }` listing the OPC-UA paths kept on the fast subscription by the alarm manager.
- `POST /api/system/restart`
  - Optional query: `?reason=<string>` — surfaced to clients on the broadcast and recorded in the sentinel file.
  - Writes `<runtime_home>/.restart-pending`, broadcasts `{type: "restarting", reason}` over `/ws`, then raises `SIGTERM` so uvicorn's lifespan teardown runs. A grace timer hard-exits if shutdown stalls. The supervisor (`backend/launcher.py` for binaries, `start-dev.py` in dev) re-execs a fresh interpreter on the next loop iteration.
  - Returns `202 { "status": "restarting", "reason": "..." }`. Frontends should poll `/api/system/info` to detect when the new process is ready.
- `GET /api/system/runtimes`
  - Returns `{ "runtimes": [ { clientId, scope, username, groups, connectedAt } ] }` for every currently-connected WebSocket scope that starts with `runtime:`. Diagnostics only.
- `GET /api/system/runtime-home`
  - Returns `{ "path": "<runtime home>" }`, resolved fresh per call from env var / bootstrap config / platform default so the answer always matches what `core.storage` sees.
  - The manifest's `defaultProjectsRoot` is *not* here — read it from `GET /api/projects/_runtime-home`, which returns both values.
- `GET /api/system/logs?lines=500`
  - Tails `<runtime_home>/.logs/nexthmi.log`. `lines` is clamped to `[1, 5000]`.
  - Returns `{ path, lines: [string], returned, total, truncated }`. A missing log file (first startup) yields an empty `lines` array, not a `404`.
- `GET /api/system/logs/download`
  - Streams the current (non-rotated) log file as `text/plain` attachment. `404` when no log file exists yet.
- `GET /api/system/historian-paths`
  - Returns `{ <datasource_name>: ["<path1>", ...] }` — the OPC-UA paths the historian keeps on the fast subscription (its enabled variables). Empty when the historian is idle.

### Manager subset

**(manager)** The manager app mounts a read-only slice of this router: `GET /api/system/info`, `GET /api/system/logs`, `GET /api/system/logs/download`. The project-only endpoints and `POST /api/system/restart` are deliberately absent — a restart there would SIGTERM the supervisor and tear down every running project. The manager's own restart lives at `POST /api/system/tls/restart` and refuses unless the stored TLS setting and the running listener disagree.

---

## TLS API

**(manager)** Base prefix: `/api/system/tls`. HTTPS is a device-level decision — one listener serves the dashboard and every project's HMI and editor — so it sits on the manager behind the device-admin session. Settings live in `core/tls_settings.py`.

Every endpoint here returns the same status object:

```json
{
  "enabled": true,
  "source": "managed | env",
  "mode": "generated | custom",
  "generatedCertificate": {
    "fingerprint": "<sha256 of the DER>",
    "expiresAt": "2027-01-01T00:00:00+00:00",
    "expiresInDays": 142,
    "expired": false,
    "expiring": false,
    "names": ["localhost", "panel-01"]
  },
  "customCertificate": null,
  "error": null,
  "httpPort": 8000,
  "httpsPort": 8443,
  "restartRequired": false
}
```

Either certificate is `null` when absent or unreadable. `source: "env"` means HTTPS is pinned by `NEXTHMI_SSL_CERTFILE` / `NEXTHMI_SSL_KEYFILE`: both certificate fields are `null`, nothing here is editable, and `error` explains it when the pinned files are missing.

`httpPort` / `httpsPort` come from `NEXTHMI_PORT` / `NEXTHMI_HTTPS_PORT` and are `null` under `start-dev.py` — which is the signal that the listener is rebound in place rather than split across two ports. `restartRequired` compares the stored setting *and* the current certificate fingerprint against what the launcher recorded at bind time, so a certificate swap while HTTPS is already on also asks for a restart.

- `GET /api/system/tls` → the status object.
- `POST /api/system/tls`
  - Body: `{ "enabled": bool, "mode"?: "generated" | "custom" }`. Takes effect on the next start; the caller follows with `/restart`.
  - Enabling `generated` with no readable certificate self-heals by generating one first.
  - `422` when enabling `custom` with no uploaded pair, or when generation fails. `409` when HTTPS is pinned by `NEXTHMI_SSL_CERTFILE` / `NEXTHMI_SSL_KEYFILE`.
- `PUT /api/system/tls/certificate/custom`
  - Multipart: `certificate` and `privateKey` (PEM, unencrypted key), each capped at `tls_settings.MAX_PEM_BYTES`. Stores the pair and switches `mode` to `custom`. `422` on an unusable pair or a storage failure; `409` when pinned by env.
- `POST /api/system/tls/certificate`
  - Regenerates the self-signed certificate — for expiry or a changed hostname. `422` on failure; `409` when pinned by env.
- `POST /api/system/tls/restart`
  - `409` unless `restartRequired` is true. Writes the restart sentinel, then shuts down gracefully so the manager's lifespan teardown stops running projects, peer discovery, and the proxy client before the socket is rebound. The supervisor re-execs; running projects resume from the persisted running set.
  - Returns `202 { "status": "restarting", "runtimeHome": "..." }`.

---

## Telemetry API

**(manager)** Base prefix: `/api/system/telemetry`. Device-level like TLS — one runtime home, one installation ID, one setting — so it sits on the manager behind the device-admin session. Implementation is `core/telemetry.py`; the operator-facing description of what is sent is [Usage reporting](../../user/install.md#usage-reporting).

The runtime POSTs `{ installId, version, edition, os, osRelease, python, event }` to `https://next-hmi.com/ping` (`event` is `start` or `heartbeat`) once from the manager lifespan and once every 24 h after that. The loop re-reads the setting before every send, so switching it off needs no restart. Failures are swallowed at `debug` — offline is the expected case, and there is no retry or queue. Test suites are covered by an autouse fixture that sets `NEXTHMI_TELEMETRY=off`.

Both endpoints return `{ "enabled": bool, "envOverride": bool | null, "installId": "<32 hex>" }`.

- `GET /api/system/telemetry` → the status object. Mints the installation ID (`<runtime_home>/.install-id.json`) if this is the first read.
- `PUT /api/system/telemetry`
  - Body: `{ "enabled": bool }`. Persists to `<runtime_home>/.telemetry.json`; absent means enabled.
  - `409` when `NEXTHMI_TELEMETRY` is set — the environment owns the setting and `envOverride` reports which way it is pinned.

The receiving end is a PHP handler on next-hmi.com (private repo): it validates the whitelisted fields, appends one JSON line per report to a monthly file above the web root, stores no IP or user agent, and always answers `204`.

---

## Historian API

Base prefix: `/api/historian`. Samples live in a SQLite database under the live project; config is `<live-project>/historian/config.json`.

- `GET /api/historian/config` → `{ "variables": { "<datasource>:<path>": { enabled, minInterval, retention } } }`.
- `PUT /api/historian/config`
  - Body: the same document. `minInterval` is seconds between samples (`0` = no throttle); `retention` is seconds (default `2592000`, 30 days). Both must be `>= 0`; extra keys are rejected (`extra="forbid"`).
  - After saving, priority subscriptions are recomputed so newly enabled variables start flowing immediately and newly disabled ones demote unless a page or alarm still holds them.
  - Returns the persisted config.
- `GET /api/historian/query?variables=a,b&start=-1h&end=now&maxPoints=500`
  - `variables` is comma-separated. `start` / `end` accept ISO timestamps or relative forms (`-1h`); `end` defaults to `now`. `maxPoints` is `[1, 10000]`, default `500`.
  - Returns `{ "series": [{ "variable": "<key>", "data": [{ "t": <epoch seconds>, "v": <value|null> }, ...] }] }`, downsampled to `maxPoints`. An unparseable time range is `422`; a database that doesn't exist yet returns an empty series list.
- `GET /api/historian/available-variables`
  - Sorted list of variable keys eligible for logging — the configured registry, not just what has a cached value, so a cold OPC-UA tag still appears in the picker. Struct kinds are filtered out; the historian only logs numeric scalars.
- `GET /api/historian/status`
  - `{ dbSizeBytes, variableCount, totalSamples, oldestSample, newestSample }`. All-zero with `null` timestamps when the database is missing or unreadable.

---

## HTTP source proxy

- `POST /api/http-request`
  - Performs one outbound request on behalf of a `$http` property source. The browser cannot call a plant REST service directly (cross-origin), so the runtime hands the resolved request here.
  - Body: `{ "url": string, "method": "GET" | "POST", "headers": { }, "body": string | null }`. `body` is only sent for `POST`.
  - Returns `200` in every case — failures are reported *in the body*, because an unreachable endpoint is a normal runtime state for a bound property:
    `{ "ok": bool, "status": int, "body": any, "error": string | null }`.
  - `ok: false` with `status: 0` for a non-`http(s)` scheme, a hostless URL, or a transport error; `ok: false` with the upstream status for a non-2xx response or a body over 1 MiB.
  - Response body is parsed as JSON regardless of `content-type` and falls back to raw text. Timeout is a fixed 10 s and redirects are followed.
  - This endpoint will call any `http(s)` URL the caller names, and is as reachable as the rest of the unauthenticated instance `/api` surface — keep it behind the same network controls.

---

## Internal API

Loopback-only hooks, driven by the manager, never by browsers. The router is reachable only on the child's `127.0.0.1` instance port; the manager reverse proxy refuses `/runtime|editor/<id>/api/internal/*`, so a browser holding a manager session can never drive it.

- `POST /api/internal/reload`
  - Body: `{ artifact_type, artifact_ids: [], source: "mcp", summary: "", diff: null, agent_label: null }`.
  - The workspace MCP runs in the manager process and edits a project's files directly; this tells the running child to re-apply the write to its live runtime and clients.
  - For `artifact_type: "variables"`, each affected datasource (`artifact_ids` are `"<datasource>/<path>"`) is re-read and its subscription delta applied against the running OPC-UA pipeline before browsers are notified.
  - Then broadcasts `config_changed` over `/ws`. Returns `{ "status": "ok" }`.

---

## Manager API

**(manager)** Mounted on the manager app only. Drives the dashboard: device-admin auth and the project supervisor (per-project child processes).

### Auth — `/api/manager/auth`

These five routes are allow-listed by the auth gate (reachable without a session cookie); everything else on the manager requires it. `change-password` still self-authenticates via `currentPassword`.

- `GET /api/manager/auth/status` → `{ passwordSet, authenticated }`.
- `POST /api/manager/auth/setup` — Body `{ password }`. Sets the device-admin password on first run and issues a session cookie. 409 if a password already exists.
- `POST /api/manager/auth/login` — Body `{ password }`. Issues a session cookie on success. `422` on wrong password; `429` (`RateLimitError`) when the in-memory throttle is locked (5 consecutive failures → 60 s lockout).
- `POST /api/manager/auth/change-password` — Body `{ currentPassword, newPassword }`. Verifies the current password (reusing the login lockout), rotates it, revokes every peer-transfer token, and reissues the session cookie so the caller stays signed in. `422` on wrong current password; `429` when locked out.
- `POST /api/manager/auth/logout` — Clears the session cookie.

### Supervisor — `/api/manager`

- `GET /api/manager/running` → `{ instances: [InstanceSnapshot] }`, where `InstanceSnapshot` is `{ id, name, path, basePath, port, pid, status, startedAt, restarts, lastError }` and `status ∈ {"starting","running","stopped","crashed"}`.
- `POST /api/manager/projects/{id}/start` → starts (or no-ops if already up) the project's child process; returns its snapshot. 202. 409 (`ConflictError`) if the project can't be started (e.g. unknown id / missing folder).
- `POST /api/manager/projects/{id}/stop` → stops the child; returns `{ id, status: "stopped" }`. 200.
- `GET /api/manager/projects/{id}/status` → the instance snapshot, or `{ id, status: "stopped" }` when not running.

### Project reverse proxy

- `ANY /runtime/{projectId}/{path}` and `WS /runtime/{projectId}/ws` (and the `/editor/{projectId}/...` alias) — the manager streams these to the matching child instance on loopback. A pending fresh-project operator setup redirects the route root to the authenticated manager setup flow and rejects other HTTP/WS traffic until completion. Otherwise, returns `503` when the project is not running and `502` on an upstream error. `GET /runtime/{projectId}` (no trailing slash) redirects to `/runtime/{projectId}/`; likewise for `/editor/{projectId}`. These carry the same project-instance API surface documented elsewhere in this file. (The legacy `/p/{projectId}/` alias was removed — backlog R24/R51.)

---

## Projects API

Base prefix: `/api/projects`. Manages the project list in the runtime-home manifest. Mounted on **both** apps; the manager dashboard is the primary caller (a project instance no longer offers an in-app projects view).

- `GET /api/projects`
  - Each project includes `operatorSetupRequired`. It is true only for a fresh
    seeded project whose initial operator password has not been set.
  - `operatorSetupStatus` is `required`, `complete`, or `error`;
    `operatorSetupError` describes missing, unreadable, corrupt, or invalid
    credential state. Error-state projects cannot be started or proxied.
  - Returns `{ defaultProjectId, defaultProjectsRoot, projects: [{ id, name, path, addedAt, lastOpenedAt, status, isDefault }] }`. `status` is computed (`"present"` or `"missing"`), not stored. The running set is authoritative for what's actually live — see `/api/manager/running`.
- `POST /api/projects`
  - Body: `{ name, path }`. Validates the destination is empty + writable, seeds from `project-seed/`, writes a fresh `project` metadata block into `config.json`, and appends to the manifest. Returns 409 when the path already carries project metadata.
- `POST /api/projects/register`
  - Body: `{ path, name? }`. Adds an existing on-disk project folder to the manifest; the folder must already carry a `project` block in `config.json`.
  - `201` with the manifest entry. `422` when the path is not a directory or has no project metadata; `409` when the id is already in the manifest — the UI offers Locate instead.
- `POST /api/projects/validate-path`
  - Non-throwing validation used by the create / import dialogs. Returns `{ valid, reason? }`.
- `GET /api/projects/browse-dir?path=<absolute path>`
  - Backs the in-app folder picker: a browser never exposes the absolute path of an OS folder dialog, so the create / add-existing / import dialogs walk the backend's real filesystem through this instead.
  - Falls back to the home directory when `path` is missing, unreadable, or not a directory (a file path resolves to its parent). Dot-directories are hidden.
  - Returns `{ path, parent, entries: [{ name, path }], error, hasConfigJson }`. `parent` is `null` at the filesystem root; `error` carries the `OSError` text for an unreadable directory while still returning the resolved `path`; `hasConfigJson` lets the dialog spot an existing project folder.
- `PATCH /api/projects/{id}`
  - Body: `{ name?, id? }` — send only what changes; an unchanged pair is a no-op that returns the entry. Renames the manifest entry and the `project` block in the folder's `config.json`.
  - An id change also moves `defaultProjectId`, the instance log folder and the widget-build cache, and re-scopes every MCP token issued for the project (so outstanding tokens follow the project instead of dangling at an id nothing answers to). It does **not** rename the folder on disk.
  - `409` when the project is in the manifest `running` set (stop it first) or when the new id is already registered — compared case-insensitively, since the id doubles as a folder name under the runtime home. `422` on an empty name, an id the grammar in `core.manifest.validate_project_id` rejects, or an id change on a project whose folder carries no metadata (the embedded id has to follow the manifest). A name-only change works with the folder missing.
- `POST /api/projects/{id}/locate`
  - Body: `{ path }`. Re-points a missing entry. Rejects (409) if the folder's metadata id doesn't match the manifest entry; rejects (422) if no metadata file is present.
- `DELETE /api/projects/{id}?deleteFolder=<bool>`
  - Removes the entry. With `deleteFolder=true`, `rmtree`s the folder — but only after confirming `config.json` contains a valid `project` metadata block (defense against wrong-path wipeouts). Refuses (409) to delete a project that is in the manifest `running` set — stop it first.
- `GET /api/projects/{id}/export`
  - Streams the project as a zip with `Content-Disposition: attachment; filename="<slug>.zip"`. 409 if the folder is missing on disk.
- `POST /api/projects/import`
  - Multipart upload: `file` (zip), `destinationPath`, optional `name`. Validates destination, unpacks, adds a manifest entry. `422` on invalid zip, unsafe or symlink archive members, a reusable-component `$var` violation at any nested child/default-value source, or a malformed JSON, invalid UTF-8, unreadable, symlinked, or reparse-point component path. Component errors report `components/<file>.json#/<JSON pointer>`; file-content errors use the root pointer with a stable reason. `409` on id collision with an existing entry. The destination is cleaned up and no manifest entry is added after any validation failure.
- `GET /api/projects/_runtime-home`
  - Used by the create dialog to suggest the default folder.

Manager-only project setup (device-manager authentication required):

- `POST /api/manager/projects/{id}/operator-setup`
  - Body: `{ "password": "..." }`.
  - Consumes a fresh seed's pending marker and atomically creates its `admin`
    HMI user with the supplied password. A completed setup or an existing
    project without the marker returns `409`, so the operation cannot be
    replayed to replace a credential.

> **Removed:** `POST /api/projects/{id}/make-live`. `make-live` is replaced by the supervisor's start/stop. The manager transfer API below replaces single-live peer push/pull.

---

## Manager peer transfer API

Wire contract only — see [peer-transfer.md](peer-transfer.md) for the trust
model, operator workflow, collision policies, and reliability guarantees.

The current workflow always names a local source project and a remote
destination project. It uses plain HTTP only on an explicitly trusted LAN;
bearer authentication does not provide confidentiality against interception.
The destination persists only a SHA-256 digest of each random peer token.

- `POST /api/manager/peer/pair` — public pairing endpoint. Body
  `{ password, name? }`; returns the plaintext token once.
- `GET /api/manager/peer/projects` — bearer-authenticated project list for
  explicit destination selection.
- `POST /api/manager/peer/transfers` — bearer-authenticated multipart receive:
  `file`, `transferId`, `sourceProjectId`, `destinationProjectId`,
  `destinationFolder`, `collisionPolicy`, `confirmReplace`, and `start`.
  The folder must be one direct child of `defaultProjectsRoot`. `reject` is the
  default. `copy` requires a new ID. `replace` requires explicit confirmation,
  a stopped registered destination, and its exact target-root folder; it keeps
  a sibling backup and rolls back on apply/manifest failure. No project starts
  unless requested, and unrelated processes/running entries are untouched.
- `DELETE /api/manager/peer/transfers/{transferId}` — cancel an in-flight receive.
- `GET /api/manager/peer/transfers/{transferId}/status` — read the durable
  receiver claim/apply/receipt status with the same bearer token.
- `POST /api/manager/peer-pair` and `POST /api/manager/peer-projects` —
  session-authenticated browser proxies for pairing and destination discovery.
- `POST /api/manager/transfers` — starts an outgoing explicit-source transfer
  with HTTP 202. `GET` / `DELETE /api/manager/transfers/{transferId}` polls or
  cancels it. Same-ID/same-parameter retries are idempotent; different
  parameters or archive bytes return 409. The sender retains the caller's
  stable ID, phase, byte progress, and archive fingerprint across restart but
  does not persist the bearer token. Connect is bounded to 10 seconds and
  transfer I/O to 10 minutes.
- `POST /api/manager/pulls` — starts an incoming explicit-source transfer with
  HTTP 202: this manager downloads
  `GET /api/manager/peer/projects/{sourceProjectId}/archive` from the paired
  peer and installs it locally, reusing the same collision/backup/rollback
  core as the receive endpoint above. `GET` / `DELETE
  /api/manager/pulls/{transferId}` polls or cancels it, with the same
  idempotent-retry and durable-across-restart behavior as `/transfers`.
- `GET /api/manager/peers/discovered`, `POST /api/manager/peers/manual`, and
  `DELETE /api/manager/peers/manual?host=...&port=...` — manager-owned mDNS and
  manual discovery.
- `GET /api/manager/peers/trust` → `{ pins: [{ host, port, fingerprint, pinnedAt }] }`
  — the certificates pinned on first contact. The PEM itself never leaves the
  server.
- `DELETE /api/manager/peers/trust?host=...&port=8000` →
  `{ host, port, forgotten: true }`; `404` when nothing is pinned for that
  host/port. The only recovery path after a peer renews its certificate, and an
  explicit operator action by design — dropping a pin discards the evidence that
  would otherwise expose an interception.
- `GET /api/manager/peer-tokens` and
  `DELETE /api/manager/peer-tokens/{tokenId}` — list non-secret metadata or
  revoke a pairing. Device-admin password changes revoke all pairings.

Project IDs are validated with the same canonical URL/filesystem-safe grammar
at the manifest, metadata, transfer, and supervisor boundaries. Receiver
commits use handle-bound atomic no-replace renames. Durable receiver phases
support startup reconciliation; ambiguous or identity-mismatched paths fail
closed as `recovery_required`. A committed-but-not-started request requires an
authenticated same-fingerprint retry before starting. The incoming multipart
request requires a bounded `Content-Length` and has an overall deadline.

---

## Theme API

A project holds **multiple named themes**, each persisted as
`<project>/themes/<id>.json` (a bare `ThemeConfig`; the id is the file
stem). The author-chosen *default* theme id is stored in `config.json`'s
`project.defaultTheme`. Schema and defaults live in `backend/models/theme.py`;
defaults are loaded from `frontend/src/shared/themeDefaults.json`. Runtime theme
switching is a client-side concern — the backend only tracks the default.

`/api/themes` (plural) is the multi-theme surface. The old singular `/api/theme`
shim was removed once no caller depended on it.

### List themes

- `GET /api/themes` → `{ "default": "<id>", "themes": [{ "id": "<id>", "config": ThemeConfig }, ...] }`
  - All themes plus the default id — enough for the runtime to switch instantly. Seeds `themes/default.json` from defaults on first access if no theme exists yet.

### Get / save / create / delete a theme

- `GET /api/themes/{id}` → `ThemeConfig`. `404` (`ThemeNotFoundError`) if the id is unknown.
- `PUT /api/themes/{id}`
  - Body: full `ThemeConfig` (all three sections required). Extra fields are rejected (`extra="forbid"`). Per-field validators apply: colors must be `#RGB`, `#RRGGBB`, or `rgb()` / `rgba()`; font families ≤ 256 chars; font weights between `100` and `900`. `422` on validation failure (`ThemeValidationError`); returns the saved theme. Creates or replaces the theme.
- `POST /api/themes`
  - Body: `{ "name": "<display name>", "source"?: "<id>" }`. Creates a new theme (id slugged from `name`), duplicating `source` when given, otherwise built-in defaults. Returns `{ "id", "config" }`. `404` if `source` is unknown.
- `DELETE /api/themes/{id}` → `{ "deleted": "<id>" }`. `404` if unknown; `409` (`ThemeConflictError`) when it is the only theme. If the deleted theme was the default, the pointer moves to the first remaining theme.

### Default-theme pointer

Kept off the `/api/themes/{id}` path so an id literally named `default` is never shadowed.

- `GET /api/default-theme` → `{ "default": "<id>" }`
- `PUT /api/default-theme`
  - Body: `{ "default": "<id>" }`. `404` if the id doesn't exist. Returns the (re-read) default id.

### Validate a theme

- `POST /api/themes/{id}/validate`
  - Body: a raw theme payload (the `{id}` path segment is not used to load anything). Validates without saving. Returns `200` in every case — both fatal parse failures and domain diagnostics share one `ThemeValidationResult` response, never FastAPI's separately-shaped automatic 422:

    ```json
    {
      "valid": true,
      "warnings": [
        { "level": "warning", "code": "contrast-low", "path": "colors.text + colors.bg", "message": "Contrast ratio 3.20:1 is below WCAG AA minimum (4.5:1)" }
      ],
      "errors": []
    }
    ```

    A malformed payload (bad color format, unknown field, out-of-range weight, ...) instead returns `valid: false` with one `errors` entry per pydantic finding, `code` set to the pydantic error `type` (e.g. `"string_pattern_mismatch"`) and `path` set to the dotted field location:

    ```json
    {
      "valid": false,
      "warnings": [],
      "errors": [
        { "level": "error", "code": "string_pattern_mismatch", "path": "colors.text", "message": "String should match pattern '...'" }
      ]
    }
    ```

  - The WCAG AA contrast check (≥ 4.5:1) covers four pairs: `text` vs `bg`, `text` vs `surface`, `text_muted` vs `bg`, `text_muted` vs `surface`.
  - `PUT /api/themes/{id}` is unchanged: it still takes a typed `ThemeConfig` body, so a malformed write still gets FastAPI's normal automatic `422`. Unifying the response shape only applies to the read-only `/validate` endpoint, whose entire purpose is to report a result rather than reject a request.

### `ThemeConfig` shape

```json
{
  "colors": {
    "bg": "#f4f6f9",
    "surface": "#ffffff",
    "surface_raised": "#fafbfc",
    "text": "#0f1722",
    "text_muted": "#5a6878",
    "accent": "#0a84ff",
    "border": "#e3e7ed",
    "ok": "#1f9e58",
    "warn": "#c47a00",
    "fault": "#c4322a"
  },
  "typography": {
    "heading_font": "'Inter', system-ui, sans-serif",    "heading_size": "1.25rem",    "heading_weight": 600, "heading_tracking": "-0.02em",  "heading_transform": "none",
    "subheading_font": "'Inter', system-ui, sans-serif", "subheading_size": "1rem",    "subheading_weight": 600, "subheading_tracking": "0",  "subheading_transform": "none",
    "body_font": "'Inter', system-ui, sans-serif",       "body_size": "0.875rem",      "body_weight": 400,    "body_tracking": "-0.005em", "body_transform": "none",
    "caption_font": "'Inter', system-ui, sans-serif",    "caption_size": "0.75rem",    "caption_weight": 400, "caption_tracking": "0",     "caption_transform": "none",
    "code_font": "'Roboto Mono', monospace",             "code_size": "0.875rem",      "code_weight": 400,    "code_tracking": "0",        "code_transform": "none",
    "value_font": "'Inter', system-ui, sans-serif",      "value_size": "1.75rem",      "value_weight": 700,   "value_tracking": "0",       "value_transform": "none",
    "label_font": "'Inter', system-ui, sans-serif",      "label_size": "0.75rem",      "label_weight": 700,   "label_tracking": "0.06em",  "label_transform": "uppercase"
  },
  "spacing": {
    "space_sm": "0.5rem", "space_md": "0.75rem", "space_lg": "1rem",
    "radius_sm": "4px", "radius_md": "6px", "radius_lg": "8px",
    "shadow": "0 1px 0 rgba(15,23,34,0.04), 0 4px 12px rgba(15,23,34,0.06)"
  }
}
```

Defaults are pulled from `themeDefaults.json` at import time — exact *values* may drift; treat the snapshot above as illustrative. The *field set* is not illustrative: typography has seven combos (`heading`, `subheading`, `body`, `caption`, `code`, `value`, `label`) × five fields (`font`, `size`, `weight`, `tracking`, `transform`), and `extra="forbid"` rejects anything outside it. See [theming.md](theming.md) for how each field maps to a CSS custom property.

---

## WebSocket

The live `/ws` protocol — handshake, every server→client and client→server
message, async-action result correlation, and `config_changed` — is documented
in full in [../architecture/websocket.md](../architecture/websocket.md).
