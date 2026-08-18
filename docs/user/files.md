# Files & assets

Some things aren't edited in the editor — they're files you put in the project folder: the logo on your header, the SVG icons on your buttons, the P&ID behind an image container, a charting library a custom widget imports. This chapter is about getting those files in, and knowing where each kind belongs.

## Where each kind of file lives

Everything below is inside the project folder. Nothing is hidden in a database.

| Folder | Put here | Reachable in the editor as |
|---|---|---|
| `assets/icons/` | `.svg` only | the **icon** picker on any `icon` field |
| `assets/images/` | `.png` · `.webp` · `.jpg` · `.jpeg` · `.gif` · `.svg` | the **image** picker on any `image` field, and the alarm popup image |
| `custom-widgets/<Name>/` | `index.tsx` (+ optional `style.css`) | the **Add widget** menu. See [Building your own widgets](custom-widgets.md) |
| `external-libraries/<name>/` | an ESM bundle | a bare `import` from any custom widget |
| `certs/` | OPC-UA client certificate + key | the datasource's **Security** settings |

Subfolders inside `assets/icons/` and `assets/images/` are scanned too, so you can organise a large asset set — `images/lines/`, `images/logos/` — and the pickers still find everything.

## Add an image or an icon

There is no upload button in the editor today. Assets are added by putting the file in the folder:

1. **Drop the file in** — copy your SVG into `<project>/assets/icons/`, or your PNG/WebP into `<project>/assets/images/`.
2. **Reload the editor tab** — the picker reads `/api/assets` when it opens, so a refresh is enough; nothing needs restarting.
3. **Pick it** — select the widget, click the `✎` on the **Icon** or **Image** field, and choose your file. The field stores a small `$static` payload naming the asset, not a copy of the bytes.

The runtime serves the whole tree read-only at `/assets/…`, mirroring the folder layout — `assets/images/logo.svg` is served at `/assets/images/logo.svg`. That is also how you reference one from a place with no picker, such as the shell's `appIcon` setting.

> [!TIP]
> **Icon fields take built-ins too.** Type a name like `gear` or `play` straight into an icon field and you get the bundled [Phosphor](https://phosphoricons.com) glyph — no file needed. The picker browses built-ins and your custom SVGs side by side.

An AI agent connected over [MCP](mcp.md) can upload assets directly with `assets_upload` (5 MB cap; SVG markup is sanitized — scripts, event handlers and `javascript:` links are stripped before the file is written). Deleting an asset over MCP is refused while any page or component still references it.

## Add a third-party library

Custom widgets must not bundle their own dependencies. Instead, drop an ESM build into `external-libraries/` and import it by name — the server generates the browser import map for you, with no core rebuild.

**Convention:** one folder per library, entry file named after the folder.

```
<project>/external-libraries/uplot/uplot.js       →  import uPlot from 'uplot'
<project>/external-libraries/uplot/uplot.css      →  import 'uplot/uplot.css'
<project>/external-libraries/three/three.js       →  import * as THREE from 'three'
```

A loose `<name>.js` directly under `external-libraries/` works too, for single-file libraries. If you need a specifier that doesn't match a filename, add an `external-modules.json` at the project root to map it explicitly — see the [custom-widget reference](../dev/reference/custom-widgets.md#using-external-libraries) for that shape.

In dev the folder is watched, so adding a library triggers a reload. In a packaged build it is read at startup.

## What travels, and what doesn't

Worth knowing before you hand a project to someone else, because it explains what they will and won't see.

| File | In a zip / push? | Why |
|---|---|---|
| `assets/`, `custom-widgets/`, `external-libraries/` | **Yes** | They are project content. |
| `widget-build/` | No | Compiled widget output — rebuilt on the far side from the `.tsx` source. |
| `historian/*.db`, `*.sqlite` (+ journals) | No | Logged samples are local to the installation that recorded them. |
| `historian/config.json` | **Yes** | The receiver needs to know which variables to log. |
| Symlinks | No | Never followed when packing, never created when unpacking. |

Full export/import mechanics are in [Managing projects](projects.md#download--upload-a-project).

## Editing project files by hand

Every file here is plain text or a plain binary, so a text editor and Git work fine — that is the point of the format. Two habits keep it painless:

- **Let the editor own what the editor writes.** Pages, themes, alarms and users are saved as whole documents. Hand-editing them while an editor tab is open risks the next Save overwriting your change.
- **Reload after an out-of-band edit.** The running backend caches configuration it has already read. Custom widgets are the exception — those are watched and recompiled on save, and pushed to open pages live.
