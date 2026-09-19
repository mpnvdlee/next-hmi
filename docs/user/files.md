# Files & assets

Some things aren't edited in the editor — they're files you put in the project folder: the logo on your header, the SVG icons on your buttons, the P&ID behind an image container, a charting library a custom widget imports. This chapter is about getting those files in, and knowing where each kind belongs.

## Where each kind of file lives

Everything below is inside the project folder. Nothing is hidden in a database.

| Folder | Put here | Reachable in the editor as |
|---|---|---|
| `assets/icons/` | `.svg` only | the **icon** picker on any `icon` field |
| `assets/images/` | `.png` · `.webp` · `.jpg` · `.jpeg` · `.gif` · `.svg` | the **image** picker on any `image` field, and the alarm popup image |
| `assets/videos/` | `.mp4` · `.webm` · `.m4v` · `.mov` | the **video** picker on any `video` field — the [Video](catalog.md#video) widget's **Video asset** |
| `custom-widgets/<Name>/` | `index.tsx` (+ optional `style.css`) | the **Add widget** menu. See [Building your own widgets](custom-widgets.md) |
| `external-libraries/<name>/` | an ESM bundle | a bare `import` from any custom widget |
| `certs/` | OPC-UA client certificate + key | the datasource's **Security** settings |

Subfolders inside `assets/icons/`, `assets/images/` and `assets/videos/` are scanned too, so you can organise a large asset set — `images/lines/`, `images/logos/` — and the pickers still find everything.

## Add an image, an icon or a video

There is no upload button in the editor today. Assets are added by putting the file in the folder:

1. **Drop the file in** — copy your SVG into `<project>/assets/icons/`, your PNG/WebP into `<project>/assets/images/`, or your MP4/WebM into `<project>/assets/videos/`.
2. **Reload the editor tab** — the picker reads `/api/assets` when it opens, so a refresh is enough; nothing needs restarting.
3. **Pick it** — select the widget, click the `✎` on the **Icon**, **Image** or **Video asset** field, and choose your file. The field stores a small `$static` payload naming the asset, not a copy of the bytes.

The runtime serves the whole tree read-only at `/assets/…`, mirroring the folder layout — `assets/images/logo.svg` is served at `/assets/images/logo.svg`. That is also how you reference one from a place with no picker, such as the shell's `appIcon` setting.

> [!TIP]
> **Icon fields take built-ins too.** Type a name like `gear` or `play` straight into an icon field and you get the bundled [Phosphor](https://phosphoricons.com) glyph — no file needed. The picker browses built-ins and your custom SVGs side by side.

An AI agent connected over [MCP](mcp.md) can upload icons and images directly with `assets_upload` (5 MB cap; SVG markup is sanitized — scripts, event handlers and `javascript:` links are stripped before the file is written). Videos are not uploadable that way — the cap is smaller than most clips — so those are copied in by hand or arrive with a project import. `assets_list` reports all three kinds, and deleting an asset over MCP is refused while any page or component still references it.

## Video files

The **Video** widget plays a recorded file: one from `assets/videos/`, or a URL you type into it. It is not a stream player — HLS playlists (`.m3u8`) and RTSP camera feeds do not play, and neither does `.mkv`, which no browser accepts in a `<video>` element. The picker lists `.mp4`, `.webm`, `.m4v` and `.mov`. The first three are safe everywhere; `.mov` is a QuickTime container that Safari and Chrome generally open but Firefox does not, so prefer `.mp4` for anything that has to run on every panel.

The file is served from `/assets/videos/…` like every other asset, and the server answers byte-range requests, so the operator can drag the scrub bar instead of waiting for the whole clip to arrive.

**H.264 (AVC) in MP4 plays everywhere.** Every browser on every panel decodes it, with hardware help or without. Use it unless file size forces your hand — which is what H.265 is for, and where the rest of this section applies.

### H.265 (HEVC) only plays where the hardware does

caniuse puts HEVC at roughly 93% of browsers, but nearly all of that is *partial* support, and the partial part is the whole story: outside Safari a browser decodes HEVC only when the operating system hands it a hardware decoder. No browser ships a software HEVC fallback — where the machine cannot decode it, nothing plays.

| Browser | HEVC | Needs |
|---|---|---|
| Safari | Full | Nothing — the one that always works |
| Chrome 107+ · Edge 107+ | Conditional | An OS-exposed hardware decoder |
| Firefox 134+ (Windows) · 136+ (macOS) · 137+ (Linux, Android) | Conditional | A hardware decoder, plus — on Linux — a system ffmpeg built with HEVC, which many distributions leave out for patent reasons |
| Kiosk Chromium on a Linux panel PC | Often none | Both of the above, on the deployment least likely to have either |

**Tag the file `hvc1`, not `hev1`.** Both are legal HEVC in MP4, but Apple's media stack decodes only `hvc1` and refuses `hev1` outright — so a clip that plays on the workshop desktop shows nothing on an iPad. Re-tagging rewrites the container, not the video, so it takes seconds and costs no quality:

```bash
ffmpeg -i in.mp4 -c copy -tag:v hvc1 out.mp4
```

**Set the Codec property.** It emits the `type` attribute on the `<source>` element, which is how the browser decides before downloading anything — and the string has to be precise. Chrome answers *no* to `video/mp4; codecs="hvc1"` even where HEVC plays fine, and *yes* to the full `hvc1.1.6.L93.B0`; the preset emits the full form. **Codec string override** is there for a file whose profile or level differs from the preset — 4K HEVC sits above the L93 the default names.

**Ship a fallback.** The reliable pattern is two files: the HEVC one as the **Video asset**, an H.264 one as the **Fallback video asset**, each with its codec set. The browser plays the first source it can decode, so the panel with a decoder gets the small file and the panel without one still shows the video. Make the companion with:

```bash
ffmpeg -i clip-hevc.mp4 -c:v libx264 -preset slow -crf 23 -c:a aac -movflags +faststart clip-h264.mp4
```

`-movflags +faststart` moves the index to the front of the file so playback can start before the download finishes — worth doing on every MP4 you ship, not just the fallback.

**A failure explains itself.** With **Show diagnostics** on (the default) the widget covers the blank frame with a panel naming each source, the type string it offered and whether the browser accepted it, plus what to do about it. The toggle only decides whether that panel is drawn — it never decides whether the video plays. It covers a source the browser refuses outright; an error that interrupts a clip already playing fires **On Error** and leaves the player as it is. The check runs up front whenever **Codec** is set to something other than **Auto**; on **Auto** the panel appears once the browser reports it could not decode any source. A **Software decode** hint is the milder case — the file plays, but on the CPU instead of the video chip, which on a panel PC is a cost you can see. That hint comes from the same up-front check, so like the check it only appears when **Codec** is not **Auto**.

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
| `certs/` | No | It holds an OPC-UA private key. The receiver generates its own pair on first connect. |
| `historian/config.json` | **Yes** | The receiver needs to know which variables to log. |
| Symlinks | No | Never followed when packing, never created when unpacking. |

Full export/import mechanics are in [Managing projects](projects.md#download--upload-a-project).

## Editing project files by hand

Every file here is plain text or a plain binary, so a text editor and Git work fine — that is the point of the format. Two habits keep it painless:

- **Let the editor own what the editor writes.** Pages, themes, alarms and users are saved as whole documents. Hand-editing them while an editor tab is open risks the next Save overwriting your change.
- **Reload after an out-of-band edit.** The running backend caches configuration it has already read. Custom widgets are the exception — those are watched and recompiled on save, and pushed to open pages live.
