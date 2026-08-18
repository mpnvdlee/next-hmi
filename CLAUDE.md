# NEXT HMI

Browser-based HMI with OPC-UA connectivity. FastAPI backend + React/Vite frontend with a
live variable pipeline over WebSocket and an in-browser editor.

**`docs/dev/operations/agents.md` is the operating manual.** It holds the hard rules, the
repo layout, the conventions, the verification matrix and the per-task file touchpoints.
This file only routes you there.

**Read [Hard rules](docs/dev/operations/agents.md#hard-rules) before your first edit in a
session** — atomic storage helpers, path resolvers, property-resolver hooks, zero inline
styles, generated files, backend config caching. Breaking one of those passes review and
fails at runtime.

Then read the row that matches what you are about to do:

| About to… | Read |
|---|---|
| Make any change | [The change loop](docs/dev/operations/agents.md#the-change-loop) |
| Get oriented in the tree | [Repo layout](docs/dev/operations/agents.md#repo-layout) |
| Touch anything under `backend/` | [Backend rules](docs/dev/operations/agents.md#backend-rules) |
| Touch anything under `frontend/` | [Frontend rules](docs/dev/operations/agents.md#frontend-rules) |
| Read or write a property value | [Property types and sources](docs/dev/operations/agents.md#property-types-and-sources) |
| Add a widget, property source, action, REST endpoint or MCP tool; change a `/ws` message | [Task recipes](docs/dev/operations/agents.md#task-recipes) — exact files per task |
| Author a custom widget | [Author a custom widget](docs/dev/operations/agents.md#author-a-custom-widget), then the `component-author` subagent |
| Run tests, lint, or regenerate docs | [Verify what you touched](docs/dev/operations/agents.md#verify-what-you-touched) |
| Start the app | [Running the app](docs/dev/operations/agents.md#running-the-app) |
| Pick a subagent or skill | [In-repo helpers](docs/dev/operations/agents.md#in-repo-helpers) |
| Answer "how does this work?" | [Canonical docs](docs/dev/operations/agents.md#canonical-docs) — one home per subject |

Architecture and behaviour: `docs/dev/INDEX.md`. Operator-facing guide: `docs/user/`.

## Always

- Keep changes scoped — don't refactor adjacent code unless asked.
- Prefer editing existing files; never create docs (`*.md`) unless asked.
- No comments unless they explain a non-obvious *why*.
- Commit only when explicitly asked.
