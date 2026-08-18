# Project-content exception

NEXT HMI is AGPL-3.0 ([LICENSING.md](LICENSING.md)). The copyleft covers the
**platform** — backend, frontend runtime, editor, and any fork or modification
of them.

It does **not** cover the **content you author with it**:

- Pages, layouts, widget trees, property expressions
- Themes and design-token overrides
- Translations and locale files
- Datasource configurations (OPC-UA endpoints, variable maps, …)
- Alarms, recipes, users, and other per-project configuration
- Custom widgets under `custom-widgets/<Name>/index.tsx`

That content is your own work, not a derivative of NEXT HMI. Keep it private,
license it as you like, ship it in a commercial product — no AGPL obligation,
and no §13 source-disclosure duty when NEXT HMI serves it over a network.

A custom widget consumes documented SDK globals on `window.__nextHMI__` (see
[docs/dev/reference/custom-widgets.md](docs/dev/reference/custom-widgets.md)).
Using a documented interface does not make your widget a derivative work; this
document exists so a strict reading of "derivative work" cannot claim otherwise.

**What this does not do:** it grants no rights in the platform code beyond the
AGPL. Modify, fork, redistribute, or network-serve a modified platform and the
AGPL applies in full, source disclosure included. If that doesn't work for you,
see [COMMERCIAL.md](COMMERCIAL.md).
