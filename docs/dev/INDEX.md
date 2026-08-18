# NEXT HMI Developer Documentation

How the product is built. Start with the architecture overview, then dive into a
focused doc. Each subject has a single home — docs cross-link rather than
duplicate.

About to change something (or you are an AI agent working in this repo)? Read
[operations/agents.md](operations/agents.md) first — it names the files each
common task touches and the checks that have to pass.

Building dashboards rather than working on NEXT HMI itself? Read the
[user guide](../user/INDEX.md) instead.

## Architecture

| Document | Contents |
|---|---|
| [architecture/overview.md](architecture/overview.md) | System map and cross-domain flow; manager + per-project instance model; links to every focused doc |
| [architecture/backend.md](architecture/backend.md) | Manager front door + supervisor/reverse proxy, single-project app, OPC-UA client pool, alarm + recipe + widget managers, shared write service, persistence, startup/shutdown |
| [architecture/frontend.md](architecture/frontend.md) | Manager dashboard, runtime base path, component registry and the compiled built-in widget stdlib, widget rendering, variable hooks, editor UI, routing, state |
| [architecture/data-formats.md](architecture/data-formats.md) | On-disk layout (project + runtime home), manifest, and every persisted file format (config, pages, alarms, recipes, widgets, theme, datasources, translations) |
| [architecture/value-types.md](architecture/value-types.md) | **Canonical** property value model — types, formats, sources (`$`-wrappers), `$var` tree, OPC-UA type collapse, resolution & coercion, component inputs |
| [architecture/websocket.md](architecture/websocket.md) | **Canonical** `/ws` protocol — handshake, server/client messages, async-action result correlation, `config_changed` |

## Reference

| Document | Contents |
|---|---|
| [reference/rest-api.md](reference/rest-api.md) | REST endpoint reference for the manager and project-instance apps |
| [reference/peer-transfer.md](reference/peer-transfer.md) | **Canonical** manager-to-manager LAN transfer — trust model, operator workflow, collision policies, reliability guarantees |
| [reference/custom-widgets.md](reference/custom-widgets.md) | Custom widget SDK, build pipeline, authoring rules, schema contract |
| [reference/theming.md](reference/theming.md) | **Canonical** theme token catalog + pipeline, `hmi-*` / `cfg-*` conventions, shared UI primitives |
| [reference/mcp.md](reference/mcp.md) | MCP server: workspace model, tool catalog, auth, per-project gating |

## Operations

| Document | Contents |
|---|---|
| [operations/deploy.md](operations/deploy.md) | Network placement + threat model, the MCP surface, and the edition seam. Installation itself is in the [user guide](../user/install.md) |
| [operations/release.md](operations/release.md) | Maintainer release checklist (build matrix, smoke tests, sign-off) |
| [operations/agents.md](operations/agents.md) | **Start here to make a change** — the contributor/AI-agent operating manual: the hard rules, repo layout, backend/frontend conventions, how to verify, the touchpoints for each common task, and the MCP path |
| [operations/dependency-policy.md](operations/dependency-policy.md) | Vendored-file provenance/checksums, and the scan/report/upgrade cadence and triage SLA for package-managed dependencies |
