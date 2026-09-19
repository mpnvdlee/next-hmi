# Pages & navigation

Pages are the screens operators move between. They live in a tree of **pages** and **page groups**, plus a **Dialogs** folder holding the pages that are only ever shown on top of another screen. This chapter walks through building that tree and giving operators a way to navigate it.

![The page tree: shell regions (header, sidebars, footer) above the page list and the Dialogs folder, each expandable and countable.](images/editor-page-tree.png)

## How the tree is organised

Open the **Editor** area in the left rail. The tree is a fixed set of collapsible sections, each with a `+` on its row:

| Section | Holds | `+` adds |
|---|---|---|
| **Header ▣** · **Left sidebar ◧** · **Right sidebar ◨** · **Footer ▄** | The shell regions that wrap every page — see [Layout](layout.md#persistent-chrome-shell-regions). | a widget to that region |
| **Pages** | The screen tree operators navigate. | a page or a page group |
| **Dialogs** | **Dialogs** and **dialog groups** — pages that are only ever opened *over* a screen, never navigated to. | a dialog or a dialog group |

## Add your first page

1. **Add it** — Click the `+` on the **Pages** section row, or right-click inside the section and pick **Add Page**. A blank page appears, selected, with its properties open on the right.
2. **Name it** — Set the page **title** in the properties panel (or double-click the tree row to rename). The title feeds the browser tab, the `$page` source, breadcrumbs and menus.
3. **Fill in the details** — Give it an **icon**, a **breadcrumb label**, and a **description** as needed — navigation widgets read these automatically.

## Group, nest, and reorganise

The tree's right-click menu is where structure happens, and it changes with what you clicked. Use it to keep related screens together and to reshape the hierarchy as the project grows.

| Menu item | Where | What it does |
|---|---|---|
| `Add Page` | Pages section, page group | Create a page — at the root of the section, or inside the group you clicked. |
| `Add Dialog` | Dialogs section | Create a **dialog** — the same page, but opened over the current screen instead of navigated to. |
| `Add Page Group` | Pages section, page group | Create a **page group** — a container that stacks its own pages and gets its own navigation. Groups can nest. |
| `Add Dialog Group` | Dialogs section | Create a **dialog group** — the same page group, opened over the current screen instead of navigated to. |
| `Rename` · `Cut` · `Copy` · `Paste` | pages, groups | The usual edits; paste drops a copied page (and its widgets) in place. |
| `Delete Page` · `Delete Page Group` | the matching node | Remove it. |

**Moving things.** Drag a row onto another: the **top or bottom quarter** drops it
before or after that row, the **middle half** drops it *inside* — into a page group, a
container, a page section or a shell area. Hovering a collapsed row for a
moment opens it, so a drag can reach anywhere without preparing the tree first.

`Cut` (`Ctrl`/`Cmd`+`X`) then `Paste` does the same move from the keyboard, and both
keep the node's **id** — bindings that name it keep working. `Copy` + `Paste` is the
opposite: it duplicates, giving the copy fresh ids. Either way the move is a single
undo step.

> [!NOTE]
> **A dialog is an ordinary page.** The Dialogs folder's `+` and its right-click menu offer **Add Dialog** and **Add Dialog Group** — the same two verbs as the Pages section, under the names the operator meets them by — and a dialog is edited on the same canvas as any other page. What the folder decides is that the page is never navigated to — it has no place in menus, breadcrumbs or the URL — and that it can take **input parameters** and carry its own **overlay** settings. Because of that, a field that *navigates* — a menu item, the Breadcrumb's home page — does not offer these pages at all, and the warnings pill flags a project that names one anyway. Drag a row between the two sections, or `Cut` and `Paste` it, to move a screen from one to the other.

**Reacting to arrival and departure.** Pages and groups both carry an **Events** section
— action lists that run when the operator arrives at that node and when they leave it.
A group is entered and left as a whole, so navigating between its own pages doesn't
re-trigger it. See [Page events](actions.md#page-events).

## Overlays: a page shown on top of the current screen

Anything that opens over a screen — a confirmation, a detail panel, a setup wizard — is a
**page**, opened with **Open Dialog** when it lives in the Dialogs folder or **Open Page
As Overlay** when it is a navigable page, and closed with **Close Dialog/Overlay** either
way. There is no separate kind of document to build: you author the widget tree on the
same canvas as any other page.

The action decides how it looks — **size** (auto / small / medium / fullscreen / fixed
pixels), **placement** (centred, edge-docked, or anchored to the button that opened it,
popover-style), and whether the backdrop **dims**. See [Actions](actions.md#screens). The
page itself carries the two settings that outlive a single opening, in its **Overlay**
section: whether a **close button** shows, and whether clicking the backdrop closes it.
Both are on unless you turn them off.

**Parameters make one page serve many.** A page in the **Dialogs** folder declares
**input parameters** in its own panel — the same mechanism a Component uses. Declare
`motorId`, and the widgets inside read it with `$componentProp`; the **Open Dialog**
action that opens the page fills the value in. One "Motor detail" page then serves every
motor on the plant instead of one page per machine. The values belong to the overlay, so
navigating inside it keeps them.

Each parameter also takes a **default value**, which applies whenever nothing supplied one.

> [!NOTE]
> **Input parameters and overlay settings appear only inside the Dialogs folder.** A page
> in the **Pages** section is a navigation destination: it is reached from a menu or a URL,
> where there is no action to hand it values. It can still be opened as an overlay — it
> just takes no parameters, and uses the default close behaviour.

**A whole page group can be opened too.** The group's active page shows inside the group's
header and footer, so the operator gets the tabs as well — one parameterised, tabbed modal
instead of one overlay per tab. A page group declares input parameters in its own panel
just like a page, and the values reach every page in the group as well as the group's own
header and footer widgets. Switching tabs inside the overlay keeps them.

Declare the same name in more than one place and the **innermost one wins**: a page's own
declaration beats the group it sits in, an inner group beats an outer one, and whatever the
action passed in beats every default. A widget in a group's header or footer sits *outside*
the pages, so it reads the group's parameters, never the open page's.

## Give operators a way around

You don't hand-wire links. Navigation widgets read the page tree and stay in sync as it changes. Add whichever fits the layout:

- **Navigation Menu** — A sidebar or top-bar menu that mirrors the page tree automatically. Choose orientation, icon/label display, flat vs. tree hierarchy, and how sub-menus expand.
- **Tab Bar** — Switches between the sibling pages of a group as tabs — ideal inside a page group.
- **Breadcrumb** — Shows the trail of pages leading to the current one, with an optional home icon.
- **Page Navigator** — Back / forward / up controls scoped to a page group's navigation
  stack. **Previous enabled** and **Next enabled** each take a binding, so a step can hold
  one control shut until the operator has filled something in while the other stays live;
  **Show previous** and **Show next** drop a control altogether rather than disabling it.

Put these in a **shell region** (see [Layout](layout.md)) so they persist while operators move between screens.

> [!NOTE]
> **Size a Navigation Menu from the Layout panel**, the same as any other widget — its **Width** and **Height** rows are what decide how much room it takes. It has no width of its own to fight you: the default **Hug** makes it as wide as its labels need, and **Fill** hands it the rest of the sidebar.
