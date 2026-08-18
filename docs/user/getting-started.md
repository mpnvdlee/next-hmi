# Getting started

Install the runtime, start it, and open the Manager — the front door where every project on this installation lives. Pick the install path that fits where you are in the lifecycle.

## Choose how to run it

All three paths run the same server against the same kind of project folder. Move between them freely.

- **From source** — For developing. Hot reload for both the runtime and your custom widgets.
- **From Docker** — For servers. One command brings up the server and the example project.
- **Portable zip** — For panel PCs. Unzip a self-contained Mac/Windows build and double-click.

```
# 1 · From source (dev, hot reload)
$ python start-dev.py

# 2 · From Docker (server)
$ docker compose up

# 3 · Portable build (macOS; double-click nexthmi.exe on Windows)
$ ./nexthmi.command
→ NEXT HMI running on http://localhost:8000
```

## First run, step by step

1. **Start the server** — Run one of the commands above. On first launch it creates its **runtime home** — a per-installation folder (default `~/Documents/NextHMI/`, or wherever `NEXTHMI_DATA_DIR` points) that holds the project manifest, logs, and the widget build cache.
2. **Open the Manager** — Browse to `http://localhost:8000`. The **Manager** lists every project registered on this installation and lets you start, stop, open, transfer and remove them.
3. **Set the device-admin password** — On a fresh installation the Manager asks you to choose one, and asks for it on every later visit. This gate gets you into the dashboard; it is separate from the per-project operator accounts you define later.
4. **Unlock the example project** — The install ships with one, seeded from the bundled template. Press **Set operator password** to create that project's `admin` HMI account; until you do, its runtime and editor stay closed.
5. **Open its editor** — Press **Start**, then **Open editor** to land under `/editor/<project>/` — or read [Managing projects](projects.md) to create your own first.

> [!NOTE]
> **Three URL areas to know.** `localhost:8000` is the Manager. A running project's operator runtime is under `/runtime/<project>/`, and its editor is under `/editor/<project>/` — with one path per config area beneath it (`/editor/<project>/datasources`, `/editor/<project>/theme`, …).

## Build your first screen

Ten minutes, no PLC needed. A **Static Variables** datasource stands in for the machine: its variables start at zero and hold whatever the HMI writes to them, so buttons, bindings and actions behave exactly as they will against a real server. Swap in an OPC-UA connection later and the screen you built here keeps working.

Work through it in the editor you opened above.

### 1 · Create the stand-in data

1. **Open the Datasources area** — Pick **Datasources** in the editor's left rail.
2. **Add the datasource** — Click the `+` on the **Datasources** row and choose **Static Variables**. Name it `Demo` and confirm. That name is the prefix of every binding you write next (`Demo:…`).
3. **Add a variable** — Right-click in the empty variable table and pick **Variable**. Fill the row in:
   - **Display Name** `Speed`
   - **Data Type** `Float`
   - **Access** — writable
4. **Add a second one** — Right-click again → **Variable**: **Display Name** `Running`, **Data Type** `Boolean`, writable.
5. **Watch the values** — Toggle **⚡ Live** in the toolbar. A **Value** column appears, showing what each variable holds right now — `0` and `false` until something writes to them.

### 2 · Make a page

1. **Open the Editor area** — Pick **Editor** in the left rail. The page tree appears.
2. **Add a page** — Click the `+` on the **Pages** section row.
3. **Name it** — Set the page **title** to `Line overview` in the properties panel on the right.

### 3 · Show a live value

1. **Add a Label** — Right-click the page in the tree → **Add Widget/Component…** → pick **Label** in the picker.
2. **Bind its text** — With the Label selected, find **Text** in the properties panel and click its **source pill** (the small square left of the field). Choose **Variable**.
3. **Pick the tag** — In the variable picker choose `Demo` → `Speed`. The canvas immediately shows `0` — that is the subscription running.

### 4 · Write back with a button

1. **Add a Button** — Right-click the page → **Add Widget/Component…** → pick **Button**. Set its **Label** to `Start`.
2. **Give it an action** — In the Button's **Actions** field, add an action and pick **Write Data Variable**.
3. **Point the write at the tag** — Choose the target with the variable picker: `Demo` → `Running`. Set **Value** to `true`. Add a second Button labelled `Stop` writing `false` to the same tag.

### 5 · React to the value

1. **Add a Status Pill** — Right-click the page → **Add Widget/Component…** → pick **Status Pill**.
2. **Make its text conditional** — Set **Text**'s source to **If Condition**. For the condition pick **Comparison**: left side a **Variable** (`Demo:Running`), operator `===`, right side `true`. Fill the **true** value with `Running` and the **false** value with `Stopped`.
3. **Do the same for the tone** — Set **Tone** the same way: `ok` when true, `neutral` when false. (Those are the pill's tone values — `accent`, `neutral`, `ok`, `warn`, `fault`.)

### 6 · Try it, then save

1. **Switch the canvas to Test mode** — In the preview toolbar, the **Mode** control has two buttons: the pencil is **Config mode** (clicks select widgets), the play button is **Test mode** (clicks run actions). Pick **Test mode**.
2. **Press Start** — The pill flips to *Running*. Press **Stop** and it flips back. The write went through the server to the datasource and came back to every subscriber, exactly as a PLC write would.
3. **Save** — `Ctrl/Cmd + S`. The project files are written to disk and every open runtime picks the change up.

You now have the whole loop: data in, a screen that reads it, a control that writes it. Where to go next — [Adding & arranging widgets](widgets.md) for the rest of the catalog, [Dynamic properties](properties.md) for what else a field can be bound to, and [Connecting to data](datasources.md) when you're ready to point at a real PLC.
