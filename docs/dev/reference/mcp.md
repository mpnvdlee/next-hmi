# MCP Server

NEXT HMI exposes a single Model Context Protocol server at the **manager's**
`/mcp` for AI-agent engineering of project state. The server is implemented in
`backend/mcp_server/` and shares storage helpers, validation, and the
WebSocket broadcast bus with the existing REST API.

> **Multi-project workspace:** the MCP is hosted by the **manager** (the only
> process that sees every project) and presents the whole workspace through one
> stable endpoint. An AI client connects once to the origin `/mcp` and never
> reconfigures as projects start, stop, or are created. Child project instances
> no longer serve MCP.

## Workspace model

1. **Discover** — call `projects_list()` to get every project with its `id`,
   `status` (running/stopped/…), and `mcpEnabled`; call `projects_get(project)` for
   full detail (path, timestamps).
2. **Select per call** — every other tool takes a required `project` argument
   (a project id). The project is *per-call context, not session state*: one
   session can act on several projects, and a project need not be running to be
   edited (editing is file-based).
3. **Operate** — the existing `pages_*`, `datasources_*`, `variables_*`,
   `alarms_*`, `translations_*`, `assets_*`, `components_*`, `users_*`,
   `widgets_*` tools act on the selected project.

The MCP is **content-only**: there are no lifecycle tools (`start`/`stop`/
`create`). Bringing projects up or down stays an operator action in the manager
dashboard.

## Transport & auth

| Aspect | Value |
|---|---|
| Path | `/mcp/` (on the manager origin, not `/runtime/<slug>/mcp`). A `Mount` only matches paths under its prefix, so bare `/mcp` would fall through to `redirect_slashes` and answer `307` — which MCP clients generally don't follow. `_McpSlashMiddleware` (`mcp_server/server.py`) rewrites `/mcp` to `/mcp/` before routing, so both spellings hit the transport. |
| Transport | MCP Streamable HTTP |
| Front door | Gated by the manager session. Headless clients send a **bearer token**: `Authorization: Bearer <token>` |
| Tokens | Paired at `POST /api/manager/mcp/pair` with `{ password, projectId, access, name? }` — the device-admin password, the project the token is scoped to, and `read` or `write`. Reachable pre-session (like login), since a pairing client has no cookie yet. Returns `{ tokenId, token, projectId, access, transport, trustedLanOnly }`; only the SHA-256 digest is persisted, in `<runtime_home>/.mcp-tokens.json`. Listed at `GET /api/manager/mcp-tokens` (id, name, projectId, access, createdAt — never the secret) and revoked at `DELETE /api/manager/mcp-tokens/{id}`. Changing the device-admin password revokes all of them. |
| Token scope | A token names **exactly one project** and one access level. `require_mcp_access` re-checks both on every tool call, so cross-project access is impossible for a token — unlike a manager session, which spans the workspace because the dashboard already grants that. |
| Per-project scope | `mcpEnabled` (per project) — reads are always allowed; **writes are refused** when off. Controlled from the manager **projects list**, persisted as `mcpEnabled` on each project's `config.json`. It is an *additional* gate: a write-scoped token still cannot write to a project with the flag off. |

OAuth 2.1 — the spec-canonical auth for HTTP transports — remains the future
direction; the bearer token is the pragmatic step for headless clients. See
*Future protocol alignment* below.

### Per-project authorization

MCP write tools (`pages_*`, `variables_*`, `alarms_*`, `assets_upload`, …) are
destructive enough that exposure is a real risk in a self-hosted distribution.
Each project carries an `mcpEnabled` flag (off by default): `projects_list`
reports it, and a write against a project with the flag off is refused with a
clear error. The flag is the per-project authorization scope; its control
surface lives in the manager dashboard's projects list.

## Agent identity

The agent label that appears in audit broadcasts comes from, in order:

1. The `x-mcp-agent` HTTP header (per-request override).
2. The MCP `initialize` handshake's `clientInfo: { name, version }`, captured
   on the session and formatted as `<name>@<version>` (or just `<name>` when
   version is absent).
3. Literal `"unknown"`.

The resolved label is normalised server-side: illegal characters (anything outside `[A-Za-z0-9_\- ]`) are replaced with `_`, leading/trailing whitespace is stripped, and the result is truncated to 64 characters. It is
advisory only: the transport is gated by the manager session / bearer token,
but any authenticated caller can set any label via `x-mcp-agent`, so treat
audit logs as best-effort attribution.

## Tools (v1)

All tool names use underscore namespacing (decision #19). Every write tool
accepts an optional `idempotency_key` (≤128 chars). Destructive ops are
two-step: call once for a dry-run diff, then again with `confirm: true` to
apply. Tool return shape is uniform `{ summary, result, diff?, ... }`
(decision #21).

Page-mutation tools (`pages_add_widget`, `pages_set_widget_property`,
`pages_set_metadata`, `pages_delete_widget`) additionally include a
`warnings: [{ path, message }]` array on every applied response. These are
the validator's advisory bucket — non-blocking issues like incomplete
`$var` bindings or references to unknown datasources/variables. The write
still succeeds; the agent should surface the warnings to the user so typos
in bindings aren't silently ignored. An empty array means a clean apply.

Read tools (`*_list`, `*_get`) cover every artifact type — list responses
share the `{ items, next_cursor? }` pagination shape (default page size 100,
max 500). MCP resources are not exposed; clients that only surface tools
(Claude's chat connector, several agent runners) still get full read access.

### Pages
- `pages_list(cursor?, limit?)` — page-index summaries
- `pages_get(page_id)` — full page JSON
- `pages_create(title?, route?, layout?) -> { page_id }` — server derives a kebab slug from the title (e.g. `"My Page"` → `"my-page"`; conflicts get a `-N` suffix) and registers the page in `config.json`
- `pages_delete(page_id, confirm?)` *destructive*
- `pages_set_metadata(page_id, patch)` — JSON Merge Patch (RFC 7396)
- `pages_add_widget(page_id, widget, parent_id?, index?|before_id?|after_id?)` — when `parent_id` is a `$component:` instance, the widget body may carry a top-level `slot` naming which of the definition's slots it fills; omitted, it lands in the first one and the response warns with `slot-unknown` if the name is unknown (see [Component slots](../architecture/data-formats.md#component-slots))
- `pages_delete_widget(page_id, widget_id, confirm?)` *destructive*
- `pages_set_widget_property(page_id, widget_id, property, value)` — `property` is a JSON Pointer (RFC 6901) into the widget's properties

### Datasources (read-only over MCP)
- `datasources_list(cursor?, limit?)` — datasource summaries
- `datasources_get(name)` — full datasource config (settings + variable tree)
- Datasource lifecycle (create / update settings / delete) is intentionally **not** exposed — manage from the UI editor or the REST API.

### Variables (semantic helpers only, no full-tree PUT)
- `variables_list(cursor?, limit?)` — flat list across all datasources; each item carries `{ datasource, path, data_type, enabled }` with `data_type` as a simple type (`boolean`/`integer`/`float`/`string`/`datetime`, plus `[]` for arrays) and `path` as a `/`-separated tree-walk. The `data_type` filter accepts a simple type.
- `variables_add(datasource, name, data_type, parent_path?, settings?)` — `data_type` is a simple type, persisted as its representative OPC-UA type (`integer`→`Int32`, `float`→`Double`, …). `name` becomes the variable's `display_name`; `parent_path` must address an existing folder (omit for root). `settings` may override defaults for the new entry — recognised keys: `writable` (bool), `value` (any), `node_id` (str, for OPC-UA sources), `array_length` (int), `enabled` (bool, default `true`), `min`/`max` (numeric range, numeric variables only).
- `variables_delete(datasource, path, confirm?)` *destructive* — `path` is the tree-walk.
- `variables_set_property(datasource, path, patch)` — JSON Merge Patch over writable fields (e.g. `patch={"enabled": false}`, `patch={"writable": true}`). The structural keys `kind`, `display_name`, and `data_type` are server-managed and must not appear in `patch`.
- Bulk ops (`variables_add_many`, `variables_import`) are intentionally deferred — see plan.

### Alarms
- `alarms_get_config()` — full `alarms.json` document (`{ version, groups: [{ id, title, alarms: [...] }] }`)
- `alarms_add(group_id, title?, level?, trigger?, settings?)` — `group_id` must reference an existing group (group lifecycle stays in the UI editor). `level` ∈ `error` / `warning` / `info` (default `warning`). The returned `alarm_id` is a kebab slug derived from the alarm's `code` (falling back to `title`). `settings` may supply additional `AlarmDefinition` fields: `code`, `description`, `image`, `auto_popup`, `resolutions`, `ack_groups`.
- `alarms_delete(alarm_id, confirm?)` *destructive*
- `alarms_set(alarm_id, patch)` — JSON Merge Patch over an alarm's fields (`title`, `level`, `trigger`, `code`, `description`, `image`, `auto_popup`, `resolutions`, `ack_groups`). `id` is server-managed and must not appear in `patch`.
- Group lifecycle (`alarms_add_group` / `alarms_delete_group` / `alarms_set_group`) is intentionally **not** exposed — create/rename groups in the UI editor.

### Translations
- `translations_list(cursor?, limit?)` — dictionary names
- `translations_get(dict_name)` — full dictionary (languages + rows + revision)
- `translations_add_language(dict_name, language_code)`
- `translations_delete_language(dict_name, language_code, confirm?)` *destructive*
- `translations_add_key(dict_name, key)`
- `translations_delete_key(dict_name, key, confirm?)` *destructive*
- `translations_set_cell(dict_name, key, language_code, value)`

### Assets
- `assets_list(cursor?, limit?)` — metadata only (fetch binaries via `GET /assets/<path>`)
- `assets_upload(name, group, content, encoding, mime?, overwrite?)` — `group` is `"icons"` or `"images"`; `name` must match `[A-Za-z0-9_\-.]+`. `encoding` selects the payload format:
  - `"svg"` — `content` is UTF-8 SVG markup; `mime` defaults to `image/svg+xml`. Sanitized before write: `<script>` and `<foreignObject>` tags are stripped, `on*` event-handler attributes are removed, and `href`/`xlink:href` values starting with `javascript:` are cleared.
  - `"base64"` — `content` is base64-encoded binary; `mime` is required (e.g. `image/png`, `image/webp`).
  Both encodings enforce a **5 MB** payload limit.
- `assets_delete(path, confirm?)` *destructive — refuses (in both dry-run and confirmed paths) if any page or component references the asset*

### Read-only domains
- `components_list(cursor?, limit?)` / `components_get(component_id)` — custom component definitions (no source code)
- `users_list(cursor?, limit?)` — narrow projection only: `{ id, display_name, roles, enabled }`. Never returns credentials.
- `widgets_get_schemas()` — full widget-schema manifest (`{ version, builtin, custom }`); needed to know which widget `type` values are valid for `pages_add_widget`.

## Prompts

Four MCP prompts ship alongside the tools (`backend/mcp_server/prompts/`, registered
via `@mcp_app.prompt` and imported by `server.import_all()`). Each is a pure
template: it takes arguments, returns a text plan naming the exact tool calls to
make in order, and touches no project data itself. They carry no access level of
their own — the tool calls they suggest are authorized normally when the client
makes them, so a read-scoped token still gets a plan it cannot fully execute.

Every prompt takes `project` as its first argument, since the workspace endpoint
serves multiple projects.

| Prompt | Arguments | Produces |
|---|---|---|
| `scaffold_page` | `project`, `brief`, `layout` (default `"single-column"`) | Plan to `pages_create` a page from a short description, check `widgets_get_schemas`, add widgets, wire `$var` bindings, verify with `pages_get` |
| `build_datasource_dashboard` | `project`, `datasource`, `max_widgets` (default `12`) | Plan to walk a datasource's variable tree and lay out up to `max_widgets` representative variables on a new page |
| `localize_strings` | `project`, `page_id`, `dict_name` (default `"Default"`) | Plan to extract a page's static strings into a dictionary and rewrite the properties as `$loc` bindings |
| `seed_alarms_from_datasource` | `project`, `datasource`, `group_title` (default `"Auto-seeded"`) | Plan to filter boolean variables whose path names a fault condition and `alarms_add` one definition each into an existing group |

`seed_alarms_from_datasource` instructs the agent to stop and ask the operator
when no suitable group exists, because group lifecycle is deliberately not an
MCP tool.

## Notifications

Every MCP-driven write publishes a *project-changed* event. Because the MCP
runs in the manager (which holds no live pipeline), the manager POSTs the
change to the edited project's running child over a **loopback-only reload
hook** (`POST /api/internal/reload`, reachable only on the child's instance
port). The child re-reads the affected files, re-applies any datasource
subscription delta, and fires the **WS `config_changed`** broadcast to every
connected browser tab. If no child is running for that project there is
nothing to notify — the files are simply current for the next start. Shape:

```json
{
  "type": "config_changed",
  "artifact_type": "page",
  "artifact_ids": ["page-home"],
  "source": "mcp",
  "agent_label": "Claude@1.0",
  "summary": "Added Container widget 'w_abc' to 'page-home'",
  "diff": [ /* RFC 6902 patch ops */ ]
}
```

Diff payload is capped at 32 KiB; oversize patches are replaced with
`{ "truncated": true, "reason": "patch_too_large", "op_count": N }`. REST-driven
writes emit the same event. MCP `notifications/resources/updated` is not
emitted (no resources are exposed); agents that mutate state should re-call
the matching `*_list` / `*_get` tool to see the new value.

## Confirm semantics

For destructive tools the first call (`confirm` absent or false) returns
`result: "dry_run"` with the diff. The agent inspects the diff and then
calls again with `confirm: true` to apply. The server is **stateless**: at
confirm time it re-validates and applies, but does **not** verify that the
dry-run diff still matches — another writer may have mutated state between
the two calls. The dry-run is informational for the agent's reasoning, not
a transaction.

## Limits

- **Confirm guards the agent, not the user.** An agent can chain dry-run and
  `confirm: true` in a single turn without human approval.
- **Dry-run is informational, not transactional.** Between dry-run and
  confirm, another writer may mutate state.
- **Read does not imply writeable.** Pre-existing project data may fail the
  new strict validators on write-back; agents must expect 422s when
  round-tripping unmodified read output.
- **Concurrent MCP writes are serialised per file**, not parallel
  (decision #24). Multi-process deployments lose this guarantee since the
  lock registry is in-memory and process-local.
- **Asset uploads reject existing paths by default** — pass `overwrite: true`
  to replace. Overwrites bypass the ref-check but agents should expect
  stale browser caches.
- **Idempotency keys are process-local with a 5-minute TTL**. A request
  whose key survives a backend restart re-executes. Cache holds only applied
  responses (not dry-runs). Keys are scoped by `(agent_label, idempotency_key)` — not by project; reusing the same key across two different projects in one session will return the first project's cached response. LRU eviction kicks in at 1 024 entries or 4 MB total size, whichever comes first.
- **Tool names use underscores** (`pages_add_widget`); dotted aliases are
  not provided.
- **Widget-schema manifest may lag by one save cycle** during dev; validation
  uses the last-published manifest.
- **Agent identity is advisory** — any caller that can reach `/mcp` can set
  any label via `x-mcp-agent`. Treat audit logs as best-effort attribution.

## Rollout

1. Set `NEXTHMI_VALIDATION_SWEEP=on` (the default). On startup the server
   walks pages and logs any new-validator findings as WARN.

## Future protocol alignment

The following deviations from canonical MCP practice are deliberate
deferrals rather than oversights:

- **OAuth 2.1** (decision #26): the endpoint is gated by the manager session
  and bearer tokens (`Authorization: Bearer`), which covers headless clients;
  OAuth 2.1 remains the spec-canonical direction generic MCP clients (Claude
  Desktop, hosted runners) will eventually expect.
- **Multi-process lock backend** (decision #24): the per-file `asyncio.Lock`
  registry is in-memory and process-local; a multi-worker deployment would
  need a file-lock or shared primitive.
- **Persisted idempotency cache** (decision #28): in-memory LRU; a richer
  deployment might want a SQLite-backed cache that survives restarts.
- **Bulk variables tools** (`variables_add_many`, `variables_import`): the
  v1 cut exposes single-add/-delete only; bulk imports of OPC-UA subtrees
  are deferred along with their confirm-gating semantics.
- **Side-by-side diff with three-button conflict resolution** in the
  frontend modal: v1 ships a lightweight notification listing pending
  changes; the full overwrite/apply/cancel flow requires per-artifact
  dirty-state tracking that is wired up as a follow-up.
