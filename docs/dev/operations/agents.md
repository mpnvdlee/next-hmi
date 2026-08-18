# Working on NEXT HMI: developer & agent workflow

The operating manual for changing NEXT HMI itself: the rules that hold always,
the exact files each common task touches, and how to verify a change. The repo
root `CLAUDE.md` routes here; this document is the content.

Two agent paths exist and do not overlap — pick by what is being changed:

| Path | Works on | Entry point |
|---|---|---|
| **In-repo coding agent** (Claude Code and friends) | this repository — backend, frontend, docs | `CLAUDE.md` at the repo root, then this document |
| **External agent over MCP** | a *project's* content — pages, widgets, bindings, alarms, translations, assets | [../reference/mcp.md](../reference/mcp.md) |

An MCP agent never edits code; a coding agent never needs MCP to change the
product.

## Hard rules

Breaking one of these usually still passes review and fails at runtime. They
apply to every change, in every directory.

- **Never write files directly on the backend.** Use the `core.storage` atomic
  helpers. Resolve every workspace path through the project-anchored resolvers in
  `backend/core/storage.py` (`active_project_root()`, `active_assets_dir()`,
  `active_custom_widgets_dir()`, …) and call the resolver *each time* —
  snapshotting one at import time breaks a live-project switch. Only
  runtime-home-anchored paths (`LOGS_DIR`, `WIDGET_BUILD_DIR`) are module-level
  constants.
- **Never parse a `$`-keyed property object by hand on the frontend.** Use the
  resolver hooks — `usePropString`, `usePropNumber`, `usePropBoolean`,
  `usePropVar`, `usePropStruct` — which carry the eval context for you.
- **Zero inline styles in components.** Tokens for every colour, size, spacing,
  radius and shadow. The single exception is setting a CSS custom property value
  via `style={{}}`.
- **Generated files are generated.** `docs/user/catalog.md` and
  `docs/user/generated/*.json` come from the widget registry — hand-editing them
  fails the drift test. `<runtime_home>/.widget-build/` is compiler output.
- **Project data is user state.** `project-testbench/` is the dev/test project:
  gitignored, absent from a public checkout, so a test that needs it must skip
  when it is missing. `project-seed/` ships in builds — changing it changes what
  every new project starts with.
- **The backend caches project config it has read.** After editing a page,
  component or datasource file directly on disk, restart the backend. Custom
  widgets are the exception: they are watched and recompiled on save.
- **Read the startup banner for the runtime home.** Resolution order is
  `NEXTHMI_DATA_DIR` → `~/.config/nexthmi/runtime.json` → `.dev-runtime-home/` →
  `~/Documents/NextHMI/`. On a machine where a packaged build has ever run,
  `start-dev.py` follows the bootstrap file, not the repo-local default.
- **Scope, comments, docs, commits.** Don't refactor adjacent code unless asked.
  Comments explain a non-obvious *why* only — identifiers carry the *what*.
  Prefer editing an existing file to creating one; never create a `*.md` unless
  asked. Commit only when explicitly asked.

## The change loop

1. **Orient.** Find the existing implementation of the thing you are adding —
   this repo almost always has a pattern already. [Task recipes](#task-recipes)
   names the files for the common cases.
2. **Match the surrounding code**, under the [hard rules](#hard-rules) above.
3. **Verify what you touched** — [the matrix below](#verify-what-you-touched).
   Run the checks that cover your change, not the whole thing.
4. **Report failures.** A failing check is the result; don't describe the change
   as done.

If a change contradicts a doc in [Canonical docs](#canonical-docs), the doc is
part of the change — update it in the same pass.

## Verify what you touched

```bash
# Backend — from repo root, venv at .venv active
pytest backend/tests
pytest backend/tests/test_config_api.py::test_name     # one test
ruff check backend

# Frontend — from frontend/
npm test -- --run                     # `npm test` alone stays in watch mode
npm test -- --run src/path/file.test.tsx
npm run lint
npm run build                         # tsc + vite build; the type check
```

| Changed | Also run |
|---|---|
| A built-in widget's registry entry or schema | `npm run docs:widgets` — regenerates `docs/user/catalog.md`, `docs/user/generated/widgets.json`, `docs/user/generated/property-sources.json`; commit them |
| Anything under `frontend/widgets/` | `npm run build:stdlib` then `npm run docs:widgets`; commit both regenerated halves of `frontend/src/generated/stdlibManifest.json` (`.json` + `.editor.json`) and the catalog. `npx tsc -p frontend/tsconfig.stdlib.json` type-checks the sources against the SDK declarations. `npm run check:bundle-budget` from `frontend/` after `npm run build` — a per-PR gate: 32 kB raw / 10 kB gzip per widget and 96 kB gzip across the tree, counting every file the widget publishes (`index.js`, `style.css`, and a `fonts/` directory if it ships one) |
| A property source | `npm run docs:widgets` (the source table is generated too) + backend validation tests |
| Anything under `project-testbench/` diagnostics | `pytest backend/tests/test_project_testbench_diagnostics.py` — a golden snapshot; a new finding must be regenerated deliberately |
| The user guide | `python build/render-docs.py <outdir> 0.0.0` — the rendered guide must build, and must load no resource from another host: an offline render fetches nothing at all, a `--web` one only the Google Fonts stylesheet. Hyperlinks in the prose may point anywhere |
| A frontend change with a visible result | the `visual-check` skill (`.claude/skills/visual-check/SKILL.md`) for a headless screenshot |

Two drift guards run in the normal frontend suite.
`frontend/src/hmi/registry/widgetMetadata.docs.test.ts` fails when the generated
docs no longer match the registry, and `npm run docs:widgets` is the only
sanctioned way to rewrite them. `stdlibManifest.test.ts` fails when
`src/generated/stdlibManifest{,.editor}.json` no longer matches what
`frontend/widgets/` compiles to — it re-runs the real compiler into a scratch
directory rather than re-deriving schemas in TypeScript, and skips only where
that compiler cannot run. Regenerate with `npm run build:stdlib`. The docs guard
reads the baked manifest, so a stale manifest agrees with stale docs: it is the
manifest guard, not the docs one, that catches an edited widget schema.

## Repo layout

- `backend/` — FastAPI app (`main.py`), the always-on manager app (`manager.py`),
  REST routers in `api/`, runtime state in `services/`, cross-cutting in `core/`,
  plus `models/`, `opcua/`, `tests/`. Python 3.14 (>=3.14.2, <3.15), venv at repo
  root (`.venv/`). Module map: [../architecture/backend.md](../architecture/backend.md).
- `frontend/` — React 19 + TypeScript + Vite, Zustand state. `src/hmi/` is the
  operator runtime, `src/config/` the config UI shell, `src/shared/` what both
  use. Path aliases `@hmi`, `@config`, `@shared`. `vite.config.ts` also hosts the
  custom-component compiler plugin. `widgets/` holds the product widgets
  authored against the custom-widget SDK and compiled at build time — see the
  README there. Module map:
  [../architecture/frontend.md](../architecture/frontend.md).
- `project-testbench/` — the dev/test project: real example content, intentional
  diagnostic findings, deliberate scale fixtures. Lives in the private enterprise
  repo and is cloned in here for dev — gitignored (root-anchored
  `/project-testbench/`), same pattern as `enterprise/`. When present it is the
  auto-bootstrapped live project in dev; when absent the backend bootstrap seeds
  a fresh `Default-Project/` from `project-seed/`. Never included in Docker or
  portable-executable builds — in production the operator creates projects
  anywhere on disk, tracked via the runtime-home manifest.
- `project-seed/` — the clean, customer-facing template, no intentional
  diagnostics. Packaged into binary/Docker builds, used by the launcher on first
  run and by the projects API when creating a fresh project.
- `<runtime_home>/` — per-installation state outside the repo: `projects.json`
  manifest, `.logs/`, `.widget-build/`, `tls/`. Resolution order under
  [hard rules](#hard-rules).
- `docs/user/` — the operator/builder how-to guide; the only tree rendered to
  HTML (`build/render-docs.py`) for the website and the in-app Help button.
- `docs/dev/` — architecture, API, custom-component SDK, styleguide; read on
  GitHub, not rendered.
- `start-dev.py` — start/stop both servers from repo root.

## Canonical docs

Each subject has exactly one home — cross-link, never restate.

| Document | Settles |
|---|---|
| [../architecture/overview.md](../architecture/overview.md) | The system map — manager + per-project instance, and which doc owns what |
| [../architecture/backend.md](../architecture/backend.md) | Backend module map and runtime behaviour |
| [../architecture/frontend.md](../architecture/frontend.md) | Frontend source layout, stores, registry, config loading |
| [../architecture/value-types.md](../architecture/value-types.md) | Property type/source model |
| [../architecture/websocket.md](../architecture/websocket.md) | The `/ws` message contract |
| [../architecture/data-formats.md](../architecture/data-formats.md) | On-disk formats for every persisted file |
| [../reference/theming.md](../reference/theming.md) | Token catalog and CSS conventions |
| [../reference/rest-api.md](../reference/rest-api.md) | REST endpoints, manager and project-instance |
| [../reference/custom-widgets.md](../reference/custom-widgets.md) | Custom widget SDK, build pipeline, schema contract |
| [../reference/mcp.md](../reference/mcp.md) | MCP workspace model, tool catalog, auth, per-project gating |

## Backend rules

Storage and path rules are in [Hard rules](#hard-rules). Beyond those:

- New endpoints go in the matching `api/<domain>_api.py`; mount the router from
  `main.py` — or from `manager.py` if it is manager-only.
- Manager singletons are module-level
  (`from services.component_manager import component_manager`); test by injecting
  fakes — see `backend/tests/conftest.py`.
- Async-first: route handlers and OPC-UA calls are `async def`. `asyncio.gather`
  for fan-out.
- Pydantic models in `models/` are the wire format; map to/from internal dicts in
  services when the shapes diverge.
- Raise domain errors from `core.exceptions` so the registered handler returns
  the right HTTP code.

## Frontend rules

Inline styles and property parsing are in [Hard rules](#hard-rules). Beyond those:

- Theme tokens come from `frontend/src/shared/utils/themeTokens.ts`; the values
  live in `themeDefaults.json`. Catalog: [../reference/theming.md](../reference/theming.md).
- The property source registry is `frontend/src/hmi/utils/propertySourceRegistry.ts`.
- Tailwind is available but prefer HMI tokens on HMI surfaces — Tailwind is
  mostly for the config UI.
- Class prefix `hmi-<name>` for HMI components; component-local CSS lives next to
  the component.
- Zustand stores live in `*/store/`. Don't reach into another store from a
  component when a hook already exists.
- Path aliases over deep relative imports.
- Tests use `@testing-library/react` + jsdom; setup is `frontend/src/test-setup.ts`.

## Property types and sources

Every property has a **type** (`String`, `Integer`, `Float`, `Boolean`,
`DateTime`, …) and a **source**. The canonical sources are: `$static`, `$var`,
`$loc`, `$if`, `$switch`, `$compare`, `$random`, `$user`, `$userGroups`,
`$device`, `$time`, `$urlParam`, `$pageIsActive`, `$widgetProp`,
`$componentProp`, `$languages`, `$stringExpr`, `$http`, `$alarmCount`,
`$recipe`, `$recipeList`, `$page`, `$viewport`, `$result`.

Icons and images are plain `$static` values carrying a structured payload
(`{ type, name }` / `{ path }`). `$componentProp` (formerly `$inputProp`) reads a
value passed in by the parent component or dialog; `$widgetProp` reads a property
exported by a sibling component. `$result` exists only inside an async action's
`onSuccess` / `onFailed` / `onSettled` handlers.

Canonical model: [../architecture/value-types.md](../architecture/value-types.md).

## Task recipes

Exact touchpoints for the changes that come up most. Every path is repo-relative.

### Add a built-in widget

Two shapes. **Prefer a stdlib widget** — same authoring contract as project
content, so it can later be forked into a project unchanged. Reach for a
compiled-in widget only when the thing genuinely needs the app graph: rendering
child widgets, the router, or a store.

**Stdlib widget** (`frontend/widgets/<Group>/<Name>/`):

1. `index.tsx` + optional `style.css`, authored against the custom-widget SDK —
   no imports, every helper an ambient global from `window.__nextHMI__`
   ([../reference/custom-widgets.md](../reference/custom-widgets.md)). Export
   `schema`, `description`, `category`, `icon`; `VISIBILITY_SCHEMA` is merged
   automatically. Add `displayName` when the folder name reads badly as a label
   (`StretchSpacer` → `Stretch Spacer`), and `hostsChildren = true` if its nodes
   carry a `children` array. Plain global class names, not CSS modules —
   chain them with `.hmi-component` (`.hmi-component.hmi-foo`) wherever the rule
   overrides something that base class sets, since a runtime-injected sheet
   cannot rely on stylesheet order.
2. `index.test.tsx` beside it, starting `import '../../testSdk';` — that binds
   the SDK globals. It is deliberately not in `src/test-setup.ts`: pulling the
   app graph into every test file defeats `vi.mock` in unrelated suites.
   Resolving a stdlib module *URL* to its source is separate and automatic —
   `vitest.config.ts` aliases `@shared/utils/widgetModuleLoader` to the
   widgets copy, so a test that renders one through the registry needs
   no setup at all.
3. `npm run build:stdlib` (also run by `dev` and `build`), then commit both
   regenerated halves of `frontend/src/generated/stdlibManifest.json`.
4. `npm run docs:widgets`, then commit the regenerated catalog.

Only three widgets are still compiled in — `ImageContainer`, `ComponentSlot`
and `NavigationMenu` — each because it renders other widgets itself.

**Compiled-in widget** (`frontend/src/hmi/components/<Name>/`):

1. Component + `index.module.css`.
2. `frontend/src/hmi/registry/widgetRegistry.tsx` — register with `name`,
   `category`, `description`, `icon`, `component`, `schema`. The category string
   groups it in the Add-widget menu and in the published catalog.
3. Spread `selfLayoutStyle(layout)` on the outer element so the editor's layout
   fields apply.
4. A test beside the component.
5. `npm run docs:widgets`, then commit the regenerated catalog.

### Add a property source

Cross-cutting: the runtime evaluates it, the editor offers it, the backend
validates it, both doc trees describe it.

1. `frontend/src/shared/types/config.ts` — the persisted shape.
2. `frontend/src/hmi/utils/propertySourceRegistry.ts` — descriptor: label,
   produced value type, default-value factory, content tier.
3. `frontend/src/hmi/utils/propertySourceEval.ts` — evaluation.
4. `frontend/src/config/components/editor/PropertySourceEditor/editors/<name>.tsx`
   plus its registration in that folder's `index.tsx`, and an icon in
   `PropertySourceSelector/propertySourceIcons.tsx`.
5. `backend/core/validation/structure.py` — add the key to
   `PROPERTY_SOURCE_KEYS` and a validation branch, so the warnings pill and the
   MCP writer both understand it.
6. Docs: [../architecture/value-types.md](../architecture/value-types.md)
   (canonical) and the source table in `docs/user/properties.md`.
7. `npm run docs:widgets`.

`$http` is the most recent worked example — grep it across those files for the
full set, including the `useHttpTick` / `httpSourceStore` plumbing an
asynchronous source needs.

### Add an action type

`frontend/src/shared/types/config.ts` (`ButtonAction` union) →
`frontend/src/hmi/utils/widgetActions.ts` and `actionDispatcher.ts` (execution;
an action that crosses the wire also needs `onSuccess` / `onFailed` /
`onSettled` and a `$result` shape) →
`frontend/src/config/components/editor/PropertiesPanel/ActionsInput.tsx`
(editor) → `backend/core/validation/structure.py` → `docs/user/actions.md`.

### Add a REST endpoint

`backend/api/<domain>_api.py`, router mounted from `main.py` — or `manager.py` if
manager-only. Pydantic models in `backend/models/`. Document it in
[../reference/rest-api.md](../reference/rest-api.md).

### Add an MCP tool

1. `backend/mcp_server/tools/<domain>.py` — decorate with `register_tool`
   (writes) or `expose_read_tool` (reads); both queue the tool so it can be
   project-scoped before registration.
2. A new module must be added to `_REGISTERED_MODULES` in
   `backend/mcp_server/server.py` — a missing entry is a silently absent tool.
3. Destructive writes go through `confirm.py`'s dry-run/`confirm: true` pair and
   `write_helpers.emit_change` so a running project reloads.
4. Tests under `backend/tests/test_mcp_*.py`; catalog entry in
   [../reference/mcp.md](../reference/mcp.md), user-visible limits in
   `docs/user/mcp.md`.

### Change a WebSocket message

[../architecture/websocket.md](../architecture/websocket.md) is canonical —
update it in the same change. `main.py` mounts `/ws` and hands every frame to
`services/websocket_manager.py`, which owns inbound validation and outbound
batching alike. `backend/tests/test_websocket_validation.py` pins the contract.

### Author a custom widget

Custom widgets are project content, not product code. They live in the live
project's `custom-widgets/<Name>/index.tsx` — in dev, the cloned-in
`project-testbench/custom-widgets/<Name>/index.tsx`. The source must NOT import
React or app helpers; every helper comes from the `window.__nextHMI__` globals
typed in `frontend/custom-widgets-sdk.d.ts`. The backend widget compiler emits
`<runtime_home>/.widget-build/<Name>/index.js` on save.

Use the `component-author` subagent; see
[../reference/custom-widgets.md](../reference/custom-widgets.md).

## Running the app

```bash
python start-dev.py           # backend :8000 + frontend :5173
python start-dev.py --stop
```

Backend uses the venv at repo root, frontend uses `frontend/node_modules`. To run
them separately:

```bash
source .venv/bin/activate && uvicorn main:app --reload --app-dir backend
cd frontend && npm run dev
```

Local dev manager sign-in password: `dev`. For a visual check of a frontend
change use the `visual-check` skill rather than describing what the screen
probably looks like.

## In-repo helpers

| Helper | Use it for |
|---|---|
| `reviewer` subagent | An independent pass over the branch diff against repo conventions |
| `component-author` subagent | Authoring a custom widget against the SDK contract |
| `visual-check` skill | Headless screenshot of the editor or runtime |
| `frontend-audit` skill | Simplification / deduplication sweep of the frontend |

## MCP surface

The manager hosts one workspace MCP server at `/mcp` exposing pages, datasources,
variables, alarms, translations and assets across *every* project. A client calls
`projects_list` to discover projects, then passes a `project` id to every other
tool. Writes are gated per project by the dashboard's **MCP enabled** toggle and
by the token's scope; project lifecycle (start, stop, create, delete) is never
exposed.

That path is for an external agent editing project *content* — a hosted runner
building screens, a desktop assistant filling in translations. Tool catalog and
limits: [../reference/mcp.md](../reference/mcp.md); operator-facing setup:
`docs/user/mcp.md`. For changes to this repository, the workflow above is the
right entry point.
