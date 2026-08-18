# NEXT HMI documentation

A task-oriented guide to building operator dashboards: projects, the editor,
widgets, layout, OPC-UA data, dynamic properties, actions, theming, translations,
alarms, recipes, the historian, users and custom widgets.

## Get started

| Page | What it covers |
|---|---|
| [Overview](overview.md) | The mental model — runtime and editor together, a project is a folder, every property can bind, one socket for data |
| [Getting started](getting-started.md) | Choosing how to run it, the first run step by step, and a ten-minute walkthrough that builds a working screen with no PLC |
| [Installing and running](install.md) | Docker and portable-binary installation, HTTPS, the on-disk model |
| [Managing projects](projects.md) | What's in a project folder, the Manager dashboard, downloading, uploading, adding and removing projects |
| [Files & assets](files.md) | Images, icons, third-party libraries — where they live and how to add them |
| [Licence](licence.md) | AGPL-3.0 in plain terms, your project content, and when you'd want a commercial licence |

## The editor

| Page | What it covers |
|---|---|
| [The editor workspace](editor.md) | The config areas and the working habits worth knowing |
| [Pages & navigation](pages.md) | Adding pages, grouping and nesting, giving operators a way around |
| [Adding & arranging widgets](widgets.md) | Placing widgets, schema-driven properties, making controls do something |
| [Layout & responsive design](layout.md) | Containers, shell regions, free placement, one project on every screen size |
| [Actions & events](actions.md) | Every action a control can run, the async result handlers, and the project-wide lifecycle events |

## Data

| Page | What it covers |
|---|---|
| [Connecting to data](datasources.md) | The OPC-UA wizard, and designing offline with a static datasource |
| [Binding & subscribing](subscribing.md) | How a bound value reaches the screen, and what a subscription costs |
| [Dynamic properties](properties.md) | Type vs. source, the value types, every source, and how they nest |
| [Historian & trends](historian.md) | Recording tag history, sampling and retention, and plotting it |

## Widgets & styling

| Page | What it covers |
|---|---|
| [Built-in widget catalog](catalog.md) | Every shipped widget and its properties — generated from the registry |
| [Theming](theming.md) | Design tokens, and theming your own widgets |
| [Translations & languages](translations.md) | Dictionaries, `$loc` keys, letting operators switch language |
| [Alarms & recipes](alarms-recipes.md) | Condition-based alarms, and parameter sets you load to live variables |
| [Building your own widgets](custom-widgets.md) | The custom-widget SDK, the build pipeline, and authoring rules |

## Operations

| Page | What it covers |
|---|---|
| [Users, groups & permissions](users.md) | Accounts and groups, signing in, gating what each role sees and may change |
| [Diagnostics & troubleshooting](diagnostics.md) | The Admin area, the manager's Settings page, the warnings pill, and the common symptoms |
| [AI agents over MCP](mcp.md) | Letting an assistant read and edit a project — enabling it, tokens, connecting a client, the starter prompts, and the limits |

## Project

| Page | What it covers |
|---|---|
| [Changelog](../../CHANGELOG.md) | What shipped in each release |
| [Security Policy](../../.github/SECURITY.md) | Supported versions, and how to report a vulnerability |

## Licensing

| Page | What it covers |
|---|---|
| [Commercial licensing](../../COMMERCIAL.md) | When you need it, and what it grants beyond AGPL |
| [License](../../LICENSING.md) | The project's licence file as shipped |
| [License (AGPL full text)](../../LICENSE) | The AGPL-3.0-or-later full text |
| [Project-content exception](../../LICENSE-EXCEPTION.md) | Why your project content isn't AGPL-covered |
| [Notice](../../NOTICE) | Third-party attributions |

<!-- ee-only -->
## Enterprise

| Page | What it covers |
|---|---|
| [Licensing](../../enterprise/docs/user/licensing.md) | Activating an enterprise build with a license key, and what add-on modules ride on top of it |
| [Audit records](../../enterprise/docs/user/audit-trail.md) | The append-only, attributed record of operator actions — an add-on module |
<!-- /ee-only -->

Working on NEXT HMI itself rather than building with it? The architecture and
API reference is in [docs/dev](../dev/INDEX.md).
