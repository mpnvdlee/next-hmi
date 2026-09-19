# Actions & events

A property answers *what a widget shows*. An **action** answers *what happens when someone presses it* — write a tag, open a screen over the current one, load a recipe, sign a user in, raise a toast. Actions are configured, not scripted, and they compose: every action's fields are ordinary properties, so any of them can be bound to live data.

## Where actions live

- **On a widget** — **Button** and **Menu Toggle** carry an **Actions** field. The list runs top to bottom on **press**.
- **Inside another action** — an alert's **OK** / **Cancel** buttons, and the `onSuccess` / `onFailed` / `onSettled` handlers of the async actions below, are themselves action lists. Nesting is how a confirm-then-write flow is built.
- **On the project** — the **Global Events** node in the editor tree runs actions at lifecycle moments rather than on a press. See [Global events](#global-events).
- **On a page or page group** — an **Events** section in the node's properties runs actions as the operator arrives and leaves. See [Page events](#page-events).

Custom widgets fire the same lists through the SDK's `executeWidgetActions`, so a hand-built control behaves exactly like a Button.

## The action catalog

Twelve types, in the order the **Add action** menu lists them. **Browse actions…** at the top of that menu opens the same catalog as a searchable drawer, grouped as below.

### Screens

| Action | Does |
|---|---|
| **Open Dialog** | Opens a page from the **Dialogs** folder — or a whole **dialog group**, which brings its tabs and chrome along — as a modal on top of the current screen. It also fills in the target's **input parameters**, which the widgets inside read with `$componentProp`. |
| **Open Page As Overlay** | Opens a navigable page from the **Pages** section — or a page group — as a modal on top of the current screen. Same presentation fields, no parameters: a navigation destination declares none. |
| **Close Dialog/Overlay** | Closes either kind, by name, or the current one when left empty. Name the page or page group the overlay was opened with — switching tabs inside it doesn't change that. |

> [!NOTE]
> **Two open actions, one close.** The two open actions differ only in which
> section their picker lists and whether input parameters come with it, so each
> one offers exactly the screens it can actually reach. Move a screen between
> the two sections and the action that named it no longer fits — the warnings
> pill flags it and names the one to use instead.

Both open actions carry the presentation fields:

- **Size** — `auto`, `small`, `medium`, `fullscreen`, or `fixed` (then set **Width** / **Height** in pixels).
- **Placement** — `center`, `top`, `bottom`, `left`, `right`, or one of the **trigger-anchored** values (`trigger-above`, `trigger-below`, `trigger-left`, `trigger-right`) which pins the panel to the control that opened it, popover-style. Anchored placement and `fullscreen` are mutually exclusive.
- **Backdrop** — `dim` darkens the screen behind, `none` leaves it untouched (right for a small anchored popover).

> [!NOTE]
> **Page-to-page navigation is not an action.** Moving between screens is the job of the navigation widgets — **Navigation Menu**, **Tab Bar**, **Breadcrumb**, **Page Navigator** — which read the page tree and stay correct as it changes. See [Pages & navigation](pages.md#give-operators-a-way-around). Actions cover the things *on top of* a page: overlays.

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

`invalid_credentials` · `rate_limited` · `permission_denied` · `bad_request` · `bad_path` · `bad_field` · `invalid_value` · `opcua_unreachable` · `write_failed` · `array_index_out_of_bounds` · `array_state_unavailable` · `timeout` · `disconnected`

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
| **onHmiLoaded** | Once, when a runtime finishes loading. The place for start-up state: pick a theme from the device, raise a "connecting" toast, open a lock-screen overlay. |
| **onPageLoaded** | On the first page and on every navigation afterwards. |
| **onUserLoggedIn** | When this runtime goes from the guest identity to a signed-in user. |
| **onUserLoggedOut** | When it goes back to guest. |
| **onLocaleChanged** | When the active language changes (not on the initial load). |

They are scoped to the runtime that triggered them, so on a multi-panel installation each screen runs its own — one operator signing in on the line-side panel does not fire `onUserLoggedIn` in the control room.

## Page events

`onPageLoaded` above fires for *every* page. When only one screen should react, put the actions on that screen instead: select a **page** or a **page group** and fill in its **Events** section.

| Event | Fires |
|---|---|
| **Page Open** / **Group Open** | When the operator arrives at this node. |
| **Page Close** / **Group Close** | When the operator leaves it. |

A **page** opens and closes on every arrival and departure — a subscribe-on-arrival, unsubscribe-on-exit pair, or a write that puts a machine into the mode the screen is for.

A **page group** is entered and left as a whole. Moving between two pages inside the same group does not close it, so group-level actions are the place for setup that all its screens share rather than something each page repeats. Nested groups unwind in order: leaving a deep page closes the page, then the inner group, then the outer one; arriving opens them outermost-first.

Reusing a page as a modal counts too — a page shown by **Open Dialog** or **Open Page As Overlay** fires its own Page Open and Page Close. Its groups are not entered, since nothing navigated into them.

Order across the two mechanisms is fixed: the project-wide `onPageLoaded` runs before the arriving page's own **Page Open**.

> [!IMPORTANT]
> **Close is not a shutdown hook.** It fires on navigation, not when a browser tab is refreshed or closed — the runtime cannot reliably run an action list on the way out. Anything a machine depends on for safety belongs in PLC logic, not in a Page Close handler.
