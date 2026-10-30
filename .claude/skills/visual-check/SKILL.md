---
name: visual-check
description: Screenshot the running NEXT HMI app (editor or preview) via headless Chromium to verify a frontend change visually. Use before reporting a UI/frontend change done, or when asked for a screenshot of the app.
---

# Visual check — headless screenshot of NEXT HMI

No `chromium-cli` here and no Playwright in `frontend/node_modules`. This skill
drives a persistent, isolated Playwright install — never the frontend's own
`node_modules`/`package.json`.

Four files in this folder do the work:

| File | Purpose |
|---|---|
| `setup.sh` | Idempotent Playwright install in a **persistent** cache dir |
| `harness.js` | Boot + selectors + capture helpers — require it, don't re-derive |
| `recipes.md` | Verified selectors, URLs, flows and the traps already hit |
| `drive-template.js` | ~20-line starting point that uses the harness |

**Read `recipes.md` before writing any drive script** — at least the section
for the surface you are driving. It answers "what is the selector for X" and
lists the traps that cost a retry.

## 1. Start the app

```bash
python start-dev.py            # from repo root, venv active
```

The dev runner serves the app over **plain HTTP on `:8000`** (Vite with HMR),
proxying to the API server on `:8001` — the same origin split a release install
resolves internally. HTTPS is opt-in from **Settings → HTTPS**, and only then is
the cert self-signed. Poll accordingly, and keep `ignoreHTTPSErrors` on so the
script survives an install that does have HTTPS turned on:

```bash
until curl -sk -o /dev/null http://localhost:8000; do sleep 1; done
```

Startup can take a few minutes; run it in the background and poll rather than
blocking on the command. Stop when done: `python start-dev.py --stop`.

## 2. Set up Playwright (first session only, ~0s after that)

```bash
bash .claude/skills/visual-check/setup.sh     # prints PW_HOME
```

Installs into `~/.cache/nexthmi-visual-check`, which **survives across
sessions** — the scratchpad does not, so installing there re-downloads every
time. Browser binaries land in the shared `ms-playwright` cache, so the second
machine-level run is instant.

## 3. Write the drive script

Copy `drive-template.js` into the scratchpad and adapt the marked middle
section. Run it with `NEXTHMI_REPO=<repo root> OUT=$SCRATCHPAD node drive.js` so
the harness resolves and screenshots land in the scratchpad.

The harness already handles: HTTPS + `ignoreHTTPSErrors`, the device-admin
password gate (dev password `dev`), the `/projects` landing page, "Open editor" opening a
**new tab**, and console/page error logging attached before navigation.

Helpers: `launch`, `watchErrors`, `dismissFullscreenPrompt`, `bootEditor`,
`propsPanel`, `panelHeader`, `canvas`, `selectTreeNode`, `selectCanvasWidget`,
`selectWidgetByName`, `widgetEl`, `fieldGroup`, `sourcePill`, `isSourceCapable`,
`openSourceMenu`, `setSource`, `closePopup`, `shot`, `shotEl`, `shotTreeClipped`. Read `harness.js` for the contract on each —
the doc comments carry the reason behind the ones that look arbitrary.

Still true and not encoded in a helper:

- **The canvas is a live HMI preview `<iframe>`.** An editor selection-overlay
  `<div>` sits on top and fails actionability ("intercepts pointer events") —
  canvas clicks need `{ force: true }` (`selectCanvasWidget` does this).
- **Container rows in the widget tree are unreliable to click** — a click can
  open the "Add Widget" context menu instead of selecting. Shell-area rows are
  fine; for a widget, click it in the canvas. Prefer `[data-widget-id="…"]`
  over text when you need a *specific* widget, and grep the live project's
  `pages/*.json` for one up front instead of clicking blind.
- **Reused CSS classes are a locator trap.** `.cfg-var-field` is shared by the
  read-only `PickerField` (a `<span>`) and the typable `$var` editor (an
  `<input>`); narrow with `:has(input)` when a specific variant matters.
- **No config-UI dark-mode toggle.** "Light theme"/"Dark theme" buttons in the
  canvas are HMI-preview *content*, not editor chrome.
- Prefer `shotEl` over `shot` for one field or panel — smaller and unambiguous.
  Exception: anything with an open popup, which portals outside the panel.
- **A real browser run catches bugs jsdom misses.** A handler calling
  `e.currentTarget.blur()` fires `onBlur` synchronously, before an earlier
  `setState` in the same handler flushed — so `onBlur` reads stale state.
  Testing-library's separate `fireEvent.keyDown` / `fireEvent.blur` calls each
  flush via `act()` and hide it. Worth a real run for any field with
  blur-commit + Escape-revert logic, even when unit tests pass.

## 4. Look at the screenshot

Read the PNG back with the Read tool before claiming the change works — a blank
frame or the login screen means the script never reached the intended state.

## 5. Stop the servers

`python start-dev.py --stop`, so the ports are free for the next run.
