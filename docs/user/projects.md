# Managing projects

A project is a self-contained folder of plain files. The **Manager** — the dashboard at the origin root — is where you create projects, register ones already on disk, start and stop them, and move them between machines.

## What's in a project folder

Everything the runtime needs is on disk, in formats you can read and diff. That's what makes a project portable and Git-friendly.

| Path | Holds |
|---|---|
| `config.json` | The page index, the shell, global events, and the project's own id and settings. |
| `pages/` | One JSON per page — the widget tree for that screen. |
| `dialogs/` | The same documents for the pages of the **Dialogs** folder — the screens an action opens as an overlay. See [Pages & navigation](pages.md). |
| `components/` | Reusable composite components you place with input properties. |
| `datasources/` | OPC-UA connections and static data, plus the browsed variable tree. |
| `alarms.json` · `alarm_state.json` | Alarm definitions, and the live acknowledgement state. |
| `recipes.json` · `recipe_state.json` | Recipe dataset types and datasets, and which dataset is loaded. |
| `themes/` · `translations/` · `users.json` | Tokens, [message catalogs](translations.md) per dictionary and language, and [accounts + groups](users.md). |
| `assets/icons/` · `assets/images/` · `assets/videos/` | SVG icons, images and videos referenced by widgets. See [Files & assets](files.md). |
| `custom-widgets/` | Your authored `.tsx` widgets. See [Custom widgets](custom-widgets.md). |
| `external-libraries/` | Third-party ESM bundles you import from widgets. |
| `certs/` | Per-project OPC-UA client certificates. |
| `historian/` | [Historian](historian.md) configuration plus this installation's local sample database. |
| `.backups/` | A zip of the whole project, taken automatically before a file-format upgrade rewrites anything. Yours to keep or delete — nothing reads them back, and they never travel with an export or a transfer. |

The backend creates any missing folder on startup, and never overwrites this tree on upgrade — it is your state, not the product's.

## The Manager dashboard

![The Manager dashboard: the toolbar's Import zip / Add existing / Pull from peer / New project buttons, above two project rows showing name, id, status, folder and per-row actions — the first with a picture of its main page, the second with the placeholder a project that has never been saved gets.](images/manager-dashboard.png)

Browse to the origin root (`http://localhost:8000` by default) and sign in with the **device-admin password**. The dashboard lists every project registered on this installation, one row each, showing its name, its **id**, its folder, and its status.

The id is the project's address: it is what appears in `/runtime/<id>/` and `/editor/<id>/`, and in the instance log folder. It is derived from the name when the project is created, and it stays put afterwards unless you change it deliberately — see **Rename** below.

Ids ignore upper and lower case: `line3` and `LINE3` count as the same id, because on Windows and macOS they would share one folder. A new project whose name gives an id that is already taken gets a free one instead (`LINE3-2`), and an import, a push or a pull that would add a second one is refused. An installation that already holds two such ids keeps working, and the log warns about them at startup — rename one of them.

Each row shows a picture of that project's main page as it looked the last time
the project was saved in the editor. A project that has never been saved shows
a plain placeholder instead. The picture is stored on this installation only —
it never travels with an export, a zip, or a transfer to another manager.

Each row carries the actions for that project:

| Control | Does |
|---|---|
| **Start** | Brings the project up as its own backend instance, with its OPC-UA connections. It becomes reachable at `/runtime/<id>/` and `/editor/<id>/`. |
| **Open** · **Open editor** | Once running, opens the operator runtime or the editor in a new tab. |
| **Stop** | Takes the instance and its connections down. |
| **Set as default** | Marks the project the origin root jumps to, and keeps it running. Handy on a panel PC that should boot straight into one screen set. |
| **MCP write enabled / disabled** | Whether an AI agent on the workspace MCP endpoint may *write* to this project. Off by default. See [AI agents over MCP](mcp.md). |
| **Rename** | Changes the project's name, its id, or both. Only while the project is stopped. |
| **Export** | Downloads the whole project as a zip. |
| **Transfer** | Pushes this project to another NEXT HMI manager on the network. |
| **Locate…** | Appears only when the folder has gone missing — re-points the entry at its new location. |
| **Remove** | Unregisters the project. |

The set of running projects is remembered, so a restart brings the same ones back up. Several projects can run side by side — starting one does not stop another.

> [!NOTE]
> **A fresh project needs no credential of its own.** A project copied from the bundled seed has only the anonymous `guest` user, so it starts and opens straight away — the device-admin password that gets you into the dashboard also gates every project's runtime and editor. Add real accounts when you want them, from the editor's [Users](users.md) area. A project whose `users.json` is missing or corrupt is the exception: it shows **Credentials unavailable** instead of Start until the file is repaired on disk.

A project saved by an older build — or by one that predates the file-format stamp — has to be upgraded before it opens, so **Start** asks first instead of starting right away. Confirming zips the whole project into its `.backups/` folder before changing anything, and a one-time notice on the Projects page names what changed and where that backup landed. Declining leaves the project untouched. A project saved by a *newer* build shows **Requires update** in place of Start, naming the version it needs — update the application to that version or later. The file format only changes in a release whose major or minor number moves, so a patch update (1.0.1 → 1.0.2) never makes a project unopenable elsewhere.

Which release writes which format, and which releases open a project it saved:

| Release | Project format | A project it saved opens in |
|---|---|---|
| 1.0.0, 1.0.1 | 9 | 1.0.0 or later |
| 1.1.0 | 11 | 1.1.0 or later |
| 1.2.0 | 12 | 1.2.0 or later |
| 1.3.0 | 12 | 1.2.0 or later |

A project's format is in its `config.json`: `project.formatVersion`, with `project.minAppVersion`, the oldest release that opens it.

## How to create a project

Three ways in, all from the dashboard toolbar. Each adds a row to the runtime-home manifest — the files live wherever you point them.

1. **New project — pick a template first.** Click **+ New project**.
   **New project** first asks what to start from. **Empty project** gives you one
   blank page. **NEXT BREW example** gives you a working demo machine — three
   pages plus a Dialogs folder (an about dialog, a sign-in dialog and a
   five-page guided brew wizard), a static datasource, alarms, recipes, two
   themes and two languages — which is the fastest way to see how the pieces fit
   together before building your own. Its `onHmiLoaded` global event writes starting values into its
   datasource on load, so if you repoint it at a real server, look at that
   event first.

   ![The Start a new project dialog: two template cards side by side — Empty project, showing a blank page outline, and NEXT BREW example, previewing the demo machine's dashboard.](images/new-project-template.png)

   Enter a **Project name** and a **Parent folder** (type it or **Browse…**); the modal previews the exact folder it will create. Confirm and NEXT HMI copies the chosen template into place and registers it.
2. **Add existing — register a folder on disk.** Click **⊕ Add existing** and give the **Project folder** path, e.g. `/opt/hmi/line-a`. The folder must already hold a `config.json` with a `project` block. Use this after cloning a project from Git or copying a folder onto the machine. The project is registered but not started.
3. **Import zip — unpack a shared build.** Click **↑ Import zip**, choose the **Zip file** and a **Destination folder**. See [Download & upload](#download--upload-a-project) below.

A project created or imported this way is never made the default automatically — that stays an explicit choice.

## Download & upload a project

The zip is the hand-off format: one file that carries the whole project, including its identity, so the other end registers it as the same project rather than a copy.

**Download (export).** **Export** on the project's row streams the folder out as `<name>.nexthmi.zip`. The compiled custom-widget cache (`widget-build/`) is skipped — it is regenerated on the far side — and so are the historian's local database files (`*.db`, `*.sqlite`, and their journals), the pre-upgrade zips in `.backups/`, and the whole `certs/` folder, all of which are installation-local. `certs/` holds an OPC-UA *private key*, which is never handed to anyone else; the receiver generates its own pair on first connect, and trusts the server certificate again (or re-uploads it) — see [Trust the server certificate](datasources.md#trust-the-server-certificate). Historian *configuration* does travel, so the receiver knows what to log. Symlinks are never followed into the archive.

**Upload (import).** **↑ Import zip** takes the **Zip file** and a **Destination folder**, unpacks it into a new project folder, and registers it. The archive's *files* are checked on the way in: path traversal and absolute paths are rejected, as is any file name with a `.`, `..` or empty folder in it, an archive holding a symlink is refused, and the total is capped by `NEXTHMI_MAX_PROJECT_ZIP_MB` (500 MB by default) so an oversize archive is refused before any bytes reach disk. That does not make the project's *content* safe to run.

**A project can contain code.** Code means its [custom widgets](custom-widgets.md), any JavaScript file in its `external-libraries/` folder, and the entries of its `external-modules.json` import map. When the zip carries any of it, **Import** stops and the dialog says what it found — for example *This project contains code: 2 custom widgets, 1 external library.* — and lists each item; tick **I trust the source of this project and want to run its code** and click **Import** again to go ahead. That code runs in the browser of everyone who opens the project, with the same access as this dashboard, and custom widgets are built on this device when the project starts — so only import projects from a source you trust. A widget can only build in files from the project's `custom-widgets/` and `external-libraries/` folders, so it cannot pick up other files on this device, but nothing limits what its code does once it runs in a browser. The same holds for a project you pull from or receive from another device.

An archive has to actually hold a project: one carrying a `config.json`
metadata block but no `users.json` is refused on the way in, rather than
registering an entry that then refuses to start. Exporting such a project is
still allowed, so a damaged one can be carried somewhere else and repaired.

Because the id travels with the archive, importing a project that is *already* registered on this installation is refused with a conflict — before the dialog asks about any code in it. Remove the existing entry first, or import onto a different machine. When the archive's id differs from a registered one only in upper and lower case — an archive of `LINE3` beside `line3` — the dialog names the existing project and offers a free id: click **Use LINE3-2 instead** to import the archive under that id.

## Push & pull between devices

**Transfer** (on a project row) pushes that project to another manager on the LAN; **⇩ Pull from peer** (in the toolbar) fetches one the other way. Both use the same packing code path as the zip, over the wire. The editor's top bar carries the same **Transfer** button for the project you have open — save your changes first, since only what is on disk travels.

Pairing takes three steps — **Verify device → Sign in → Send** (**Fetch** when pulling). The dialog starts on HTTPS, port 8443; picking a discovered device fills in its own protocol and port. First compare the other device's certificate fingerprint with the **SHA-256** under **Settings › HTTPS** on that device; only then type its device-admin password. After that a peer token authenticates the transfer; it expires after 90 days without use, and the other device can revoke it under **Settings › Tokens**. Tick **Remember this device** (off by default) to keep it, so the next transfer needs no password; **Forget pinned certificate and verify again** drops it along with the pin. Discovery is by mDNS, and a peer can always be entered manually as `host:port` — a peer found both ways is offered once, not twice. The full trust model and the HTTPS certificate pinning are in [Installing and running](install.md#peer-transfer-over-https).

**Pulling a project that contains code.** Custom widgets, external libraries and import-map entries are code (see [Download & upload a project](#download--upload-a-project) above). When the source says the project has any, the dialog names it — for example *This project contains code: 2 custom widgets, 1 external library.*, then each item — and asks you to tick *I trust the source of this project and want to run its code*; it asks too when the source does not say. The manager checks the downloaded project itself before installing it, and refuses the pull without that tick.

**When the far side already has that project.** The dialog checks before it
sends, so a clash on the project's **id**, its **destination folder**, or both
is named up front rather than surfacing as a failure. An id that differs only
in upper and lower case is a clash too, but the far side is what spots it: the
transfer fails with *A project or folder of that name already exists on the
target. Project ids ignore upper and lower case.* and the same choices open.
Pick how to resolve it:

| Resolution | Does |
|---|---|
| **Don't overwrite anything** | The default. The transfer is refused if anything is in the way. |
| **Install as a separate copy** | Installs alongside the existing project under a new id. |
| **Replace the existing project** | Overwrites it — only a stopped project, only after you confirm, and rolled back if the install fails partway. |

Replacing keeps the users on the far side by default: the accounts, passwords
and languages operators set there stay, and groups and settings come from your
project. Untick **Keep the users on the destination** to send your accounts
instead. See [Manage users from the runtime](users.md#manage-users-from-the-runtime).

**When it fails anyway.** The dialog says what went wrong and what to do about
it, instead of printing a raw error: a wrong device-admin password (the
*peer's*, not this manager's), a pairing lockout with the countdown to wait
out, a host name that didn't resolve, an address outside the trusted LAN, a
port with nothing listening, a failed TLS handshake, a peer certificate that
no longer matches the one you confirmed when pairing, or a peer that no longer
accepts this device because the pairing was revoked or expired — **Pair again**
then asks for its device-admin password. Progress is named the same
way as it runs — packing, uploading, extracting, backing up, installing,
registering, starting.

> [!IMPORTANT]
> Pairing needs HTTPS on the other device: over plain HTTP its password would cross the network unencrypted. Pairing over HTTP is possible only after you confirm, under **Isolated network without HTTPS?**, that the network is closed to other devices.

## Move, repair, and remove

- **Moved the folder?** The row goes to a **missing** status and grows a **Locate…** button — the one action still available, since every other one needs the folder that is gone. Give it the new path and the entry is re-pointed. The destination's `config.json` must carry the same project id, so a typo can't silently attach the entry to an unrelated tree.
- **Rename** changes the display name, the id, or both — stop the project first. The **name** is cosmetic. The **id** is the address: every `/runtime/<id>/` or `/editor/<id>/` bookmark pointing at the old one breaks, and any client using the old URL has to be updated. Everything on this installation follows along automatically — the manifest entry, the project's own `config.json`, the default-project choice and the instance logs. The folder on disk keeps its path; move it with **Locate…** if you want that renamed too. An id must start with a letter or digit and hold only letters, digits, `.`, `_` or `-`, and it cannot collide with another registered project.
- **Remove** unregisters the project. By default your files on disk are left alone and only the manifest row goes; tick **Also delete the folder on disk** in the confirmation to erase it too. Deleting the folder is refused if it has no `project` block in `config.json`, which stops a stale path from wiping something unrelated.
- A running project must be **stopped** before it can be removed.

## Licensing, in one line

The open-source build is AGPL-3.0 and complete — historian, alarms and recipes are all in the box, with no licence key, no feature unlock and no runtime check anywhere in the code. What you author in these folders is yours. See [Licence](licence.md).
