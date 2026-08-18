# Actions & events

A property answers *what a widget shows*. An **action** answers *what happens when someone presses it* — write a tag, open a dialog, load a recipe, sign a user in, raise a toast. Actions are configured, not scripted, and they compose: every action's fields are ordinary properties, so any of them can be bound to live data.

## Where actions live

- **On a widget** — **Button** and **Menu Toggle** carry an **Actions** field. The list runs top to bottom on **press**.
- **Inside another action** — an alert's **OK** / **Cancel** buttons, and the `onSuccess` / `onFailed` / `onSettled` handlers of the async actions below, are themselves action lists. Nesting is how a confirm-then-write flow is built.
- **On the project** — the **Global Events** node in the editor tree runs actions at lifecycle moments rather than on a press. See [Global events](#global-events).

Custom widgets fire the same lists through the SDK's `executeWidgetActions`, so a hand-built control behaves exactly like a Button.

## The action catalog

Thirteen types, in the order the **Add action** menu lists them.

### Screens

| Action | Does |
|---|---|
| **Open Dialog** | Opens a dialog from the **Dialogs** section, optionally passing **input properties** the dialog's widgets read with `$componentProp`. |
| **Close Dialog** | Closes a named dialog, or the current one when left empty. |
| **Open Page Overlay** | Opens an ordinary **page** as a modal on top of the current screen — reuse a full page as a popup without rebuilding it as a dialog. |
| **Close Page Overlay** | Closes a named page overlay, or the current one when left empty. |

Both *open* actions share the same presentation fields:

- **Size** — `auto`, `small`, `medium`, `fullscreen`, or `fixed` (then set **Width** / **Height** in pixels).
- **Placement** — `center`, `top`, `bottom`, `left`, `right`, or one of the **trigger-anchored** values (`trigger-above`, `trigger-below`, `trigger-left`, `trigger-right`) which pins the panel to the control that opened it, popover-style. Anchored placement and `fullscreen` are mutually exclusive.
- **Backdrop** — `dim` darkens the screen behind, `none` leaves it untouched (right for a small anchored popover).

> [!NOTE]
> **Page-to-page navigation is not an action.** Moving between screens is the job of the navigation widgets — **Navigation Menu**, **Tab Bar**, **Breadcrumb**, **Page Navigator** — which read the page tree and stay correct as it changes. See [Pages & navigation](pages.md#give-operators-a-way-around). Actions cover the things *on top of* a page: dialogs and overlays.

### Machine

| Action | Does |
|---|---|
| **Write Data Variable** | Pushes a value to a writable tag — a coil, a mode, a setpoint. Target is a datasource + path; the **value** is a property, so it can be a literal, another tag, or a computed `$if`. |
| **Recipe: Load** | Downloads a saved dataset into its variables. **Dataset** may be fixed or bound (a row id from a `$recipeList` grid). **Verify** reads the values back after writing and fails the action if they didn't take. |
| **Recipe: Save** | Captures current live values into a dataset. Leave **Dataset** empty to update the one that is loaded. |

### Session

| Action | Does |
|---|---|
| **Login User** | Signs this runtime in with a **Username** and **Password** — both properties, so they come from wherever the operator typed them. |
| **Logout User** | Drops back to the auto-login user. |

See [Users, groups & permissions](users.md#sign-in-and-out-on-a-screen) for the sign-in screen around them.

### Interface

| Action | Does |
|---|---|
| **Set Language** | Switches the interface language by code (`nl-NL`). See [Translations](translations.md). |
| **Set Theme** | Switches the active theme by id — day/night buttons, or a per-line brand. See [Theming](theming.md). |
| **Show Alert** | A modal with a **Title**, **Description**, and two buttons whose captions you set. **OK** and **Cancel** each run their own action list, which is how you gate a dangerous write behind a confirmation. `dismissible` decides whether clicking away counts as cancel. |
| **Show Toast** | A transient message — **severity** `info` / `warning` / `error`, **discard** `auto` (after **duration**, 4000 ms by default) or `manual`. The message is a property, so `$loc` and `$var` work in it. |

## Async actions and `$result`

Five actions cross the wire and therefore *may fail*: **Write Data Variable**, **Recipe: Load**, **Recipe: Save**, **Login User**, **Logout User**. Each carries three optional handler lists:

- **onSuccess** — the server acknowledged.
- **onFailed** — the server refused, or the request timed out (10 seconds) or the connection dropped.
- **onSettled** — always, after whichever of the two ran.

Inside those handlers the **`$result`** source reads fields of what came back. Which fields exist depends on the action:

| Action | onSuccess | onFailed |
|---|---|---|
| **Login / Logout User** | `username`, `groups`, `groupLabels` | `reason` |
| **Write Data Variable** | `datasource`, `path` | `datasource`, `path`, `reason` |
| **Recipe: Load** | `result`, `datasetId`, `written`, `total`, `verified`, `failures` | `reason` |
| **Recipe: Save** | `datasetId` | `reason` |

`onSettled` sees the union of both. The `reason` vocabulary is fixed, so you can branch on it with `$compare`:

`invalid_credentials` · `permission_denied` · `bad_request` · `bad_path` · `bad_field` · `invalid_value` · `opcua_unreachable` · `write_failed` · `array_index_out_of_bounds` · `array_state_unavailable` · `timeout` · `disconnected`

A worked pattern — a Start button that confirms, writes, and tells the operator either way:

```
Button "Start"
└─ Show Alert   title "Start line 3?"  ok "Start"  cancel "Cancel"
   └─ onOk
      └─ Write Data Variable   LinePLC:Line3/Start = true
         ├─ onSuccess → Show Toast  "Line started"        severity info
         └─ onFailed  → Show Toast  { $result: "reason" }  severity error
```

> [!TIP]
> **No handlers means fire-and-forget.** An action with all three lists empty skips the request/response round trip entirely — which is what you want for a control that writes continuously, like a slider being dragged.

## Global events

Some things should happen because *the system reached a state*, not because someone pressed something. Select **Global Events** in the editor tree and attach action lists to:

| Event | Fires |
|---|---|
| **onHmiLoaded** | Once, when a runtime finishes loading. The place for start-up state: pick a theme from the device, raise a "connecting" toast, open a lock-screen dialog. |
| **onPageLoaded** | On the first page and on every navigation afterwards. |
| **onUserLoggedIn** | When this runtime goes from the guest identity to a signed-in user. |
| **onUserLoggedOut** | When it goes back to guest. |
| **onLocaleChanged** | When the active language changes (not on the initial load). |

They are scoped to the runtime that triggered them, so on a multi-panel installation each screen runs its own — one operator signing in on the line-side panel does not fire `onUserLoggedIn` in the control room.
