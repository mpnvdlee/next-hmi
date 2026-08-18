# Overview

A complete, task-oriented guide to developing operator dashboards with NEXT HMI — the open-source, browser-based HMI/SCADA that connects to PLCs over OPC-UA. Every chapter is a how-to: what to click, what to type, and why.

## The mental model

Four ideas carry through everything else. Hold these and the rest of the guide falls into place.

- **Runtime + editor together** — A single FastAPI server hosts the OPC-UA connection pool, serves operator screens, and hosts the in-browser editor. There is nothing else to install on the floor.
- **A project is a folder** — Pages, datasources, alarms, theme, translations and users are JSON/CSV on disk. Diff it in Git, zip it, copy it to another machine.
- **Every property can bind** — Instead of separate static/tag/expression modes, every property is a literal or a `$`-keyed object naming its source — and sources nest.
- **Data streams over one socket** — The server subscribes to your tags and pushes updates to every browser over a single WebSocket, prioritising what's on screen.

## How to read this guide

Chapters build on each other. If you're brand new, start at **Getting started** and work down the sidebar. If you're here for one thing, jump straight to it:

- **Set up & run** — [Getting started](getting-started.md) and [Managing projects](projects.md) cover installing, first run, and creating / sharing / moving projects.
- **Build screens** — [The workspace](editor.md), [Pages & navigation](pages.md), [Adding widgets](widgets.md), [Layout](layout.md) and [Actions & events](actions.md).
- **Wire up data** — [Connecting to data](datasources.md), [Binding & subscribing](subscribing.md), [Dynamic properties](properties.md), [Historian & trends](historian.md).
- **Widgets & polish** — the [catalog](catalog.md), [theming](theming.md), [translations](translations.md), [alarms & recipes](alarms-recipes.md), and [custom widgets](custom-widgets.md).
- **Run it for real** — [Users, groups & permissions](users.md) and [Diagnostics & troubleshooting](diagnostics.md).

> [!TIP]
> Prefer light or dark? Use the toggle in the top bar — your choice sticks as you move between pages.
