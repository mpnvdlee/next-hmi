# Layout & responsive design

Layout is flex-based, not pixel-nailed. You group widgets in containers, decide how each child grows and aligns, and let the runtime reflow. Then you branch the layout by screen size so one project serves phone, tablet and panel PC.

## Build layout with containers

1. **Add a Container** — Drop a **Container** where you want a group. Set its **Direction** — row or column — plus **Gap** and **Align**.
2. **Nest your widgets** — Move widgets into the container in the tree. They flow in order along the direction you chose.
3. **Tune each child** — Select a child and set its **Width** and **Height** to **Hug**, **Fill** or **Fixed**. This is how you get "this panel fixed, that one fills the rest".

> [!TIP]
> Use a **Stretch Spacer** to push widgets apart (by ratio or percent) and a **Fixed Spacer** for an exact pixel gap — cleaner than padding hacks.

## The layout fields

Every widget's properties panel has a **Layout** section. It shows two groups: how this widget arranges *its children* (containers only), and how this widget *places itself* in its parent.

**Arranging children** (the **Container** widget only) — Direction · Gap · Align · Padding · Radius. An **Image Container** hosts children too, but it pins them to points on the image rather than flowing them, so it has no row for any of these.

**Placing itself** — Width · Height.

**Bounds** — Min width · Max width · Min height · Max height, each under the axis it bounds. Floors and ceilings on the size the mode works out, for a Fill that must not get too narrow or a Hug that must not run away.

Every row is on screen from the start; nothing is folded behind a disclosure. A max-width you set once and then cannot see is a max-width that quietly wins arguments you are not having.

There is no row for the raw flex properties — no Basis, Grow, Shrink or Align self. Direction, Align and the two size modes cover what they covered, and a panel that offers both invites you to set the same thing twice and get a fight.

### Width and Height

Each is one row: a length and a mode.

| Mode | The widget is |
|---|---|
| **Hug** | As big as its own content needs. |
| **Fill** | As big as the parent has room for — the rest of a row, the rest of a column, the rest of the screen. Two Fill siblings split the space evenly. |
| **Fixed** | Exactly the length you type. The length is only editable here; under Hug and Fill the size is derived, so the field shows a dash. |

**Fill weight** sits in its own row below Width and Height: how many shares of the leftover space this widget takes against its Fill siblings. Leave it empty for one share; set `2` to take twice what a plain Fill sibling takes. It appears as soon as either axis is set to Fill, and there is one weight for the widget rather than one per axis — which is why it sits below both rows instead of inside either. It only ever counts along whichever axis is currently the container's own direction; on the other axis the number is still stored and still editable, without anything rendering by it.

Flipping the container's **Direction**, or dragging the widget into a container that flows the other way, never deletes the weight, and never moves it onto an axis you didn't set to Fill yourself. Each axis's own mode decides on its own whether that axis reads the shared number — a flip only changes *which* axis the container treats as the one that matters, not what either axis's own mode says. So a weight on **Height: Fill** can stop rendering after a flip to a row-flowing container (Height is now the one that doesn't matter) without Width ever picking it up in its place — Width only reads it if Width's own mode is Fill too. The weight row keeps showing and editing the number regardless of which axis currently renders by it; when the only axis still reaching it is one you left unset, the row is cosmetic — it hedges in case that axis turns out to matter, but never actually renders the weight until you set it to Fill yourself.

Switching a mode to Hug or Fixed by hand only deletes the weight once no axis can reach it any more — and "reach" is wider than "still literally Fill": an axis left unset still reaches it too, the same default that lets a flip revive a weight, and a bound or multi-selected mode on the other axis is read the same cautious way, kept rather than risked. With the other axis still Fill, or still unset, or still unresolved, the number stays and the row stays with it.

**Fill** is how you make a widget as big as possible without scrolling: set **Height: Fill** on the widget, and on every container between it and the page. One container left on Hug is enough to stop the chain — it sizes to its content and has no leftover height to hand down.

**Hug** and **Fixed** hold their size when the container runs out of room: the container overflows rather than the widget being squeezed below the size you asked for. Only **Fill** gives space back, because giving space back is what it is for.

The mode you pick along the container's own direction is a different mechanism from the one across it — the editor picks the right one for you, which is the part that is easy to get wrong by hand.

### Align and Distribute

Two rows of icons, one question each:

- **Align** — where the children sit *across* the direction of flow, or **Stretch** to have them fill it. Stretch is the default, and it is what a child's cross-axis **Fill** rides on.
- **Distribute** — where they sit *along* the direction of flow, plus **Space between** and **Space around** for spreading them out instead of bunching them together.

Each icon draws the arrangement it picks, and both rows follow the container's **Direction**: in a row the Align icons move children up and down, in a column they move them left and right. Hover an icon and it names the position you will get — Top, Middle, Bottom or Left, Center, Right — so you never have to work out which CSS property the direction turned it into.

### Padding

Four rows — **Padding top**, **right**, **bottom** and **left** — one per side, each independent. Clear one and it falls back to the theme's own default padding, never to whatever the other three happen to share, so emptying a side can't silently borrow a number from its neighbours.

There is no **Margin**. Spacing between widgets is the parent's job — a container's **Gap** and **Padding** — which is one place to look instead of two that add up. A margin stored by an older project no longer renders at all: space that widget with its parent's gap or padding instead.

Length fields take any CSS length — `200px`, `100%`, `12rem`, `auto` — so you can mix fixed and proportional freely. Leave a field empty and it inherits: Radius falls back to the theme's `--hmi-radius` rather than to a hardcoded value.

Layout fields are properties like any other, so they can be **bound**. A sidebar's width driven by `$if`, a gap that changes with `$viewport`, one padding side driven by a variable while the other three stay fixed — no CSS involved. Every layout row carries the same source pill as any other property, so binding one is the same gesture everywhere.

## Persistent chrome: shell regions

A page's content scrolls, but navigation and status shouldn't. The **shell** wraps every page with four fixed regions you fill once:

- **Header ▣** — Top bar — page title, alarm summary, language switcher.
- **Left / Right sidebar ◧ ◨** — Navigation menu, quick actions, live KPIs.
- **Footer ▄** — Status line, connection state, clock.
- **Content** — The active page renders here; the shell stays put around it.

Each region appears in the page tree above the page list. Select one and its properties give you the region's behaviour, not just its contents:

| Setting | Does |
|---|---|
| **Enabled** | Whether the region exists at all. |
| **Expanded size** · **Collapsed size** | The region's size in each state — width for a sidebar, height for header/footer. |
| **Expanded** | Whether it is currently open. Bindable, so a menu-toggle button or a tag can drive it. |
| **Default state** | `expanded`, `collapsed`, or `hidden` on load. |
| **Overlay** | When expanded, float over the content instead of pushing it aside — the usual choice on a phone. |
| **Full height** (sidebars) | Span the whole layout height, flanking the header and footer instead of sitting between them. |
| **Background** | The region's background colour. |

Those settings are project-wide. A single page can override them in its own properties, under **Shell override (this page only)** — one toggle per region, hiding it for that page. That's how you get a full-screen trend or a login screen with no navigation at all, without touching the rest of the project.

Project-wide shell settings also cover the browser **tab title**, the **favicon** (a path under `assets/`, see [Files & assets](files.md)), an **HMI scale** factor that zooms the entire layout for a small or very large panel, and **Locked feedback** — what an operator gets when they press a widget that is not **Interactable** (see [Users, groups & access](users.md#what-a-locked-widget-does)). The boot screen's branding is fixed in the open-source build (see [Licence](licence.md#the-attribution-notice)).

## Place freely over an image

For a P&ID, a floor plan, or a machine photo, use an **Image Container** instead of a flex Container. It hosts children at **absolute positions** on top of a background image — a valve indicator here, a temperature readout there. Set **Fit** for how the image scales, and **Collapse below** to a pixel width under which the absolute placement is abandoned and children stack normally, so a phone doesn't get a postage-stamp overview.

![The viewport selector switches the canvas between fit-to-screen, laptop, tablet and phone; the mode toggle switches between editing and preview.](images/editor-viewport-selector.png)

## One project, every screen size

Rather than maintaining separate designs, branch any property on the **viewport**. Bind it with `$viewport` and choose a value per size class — no media-query CSS anywhere.

```
// stack on a phone, sit side-by-side on a laptop
"direction": {
  "$switch": {
    "value": { "$viewport": { "field": "size" } },
    "cases": [
      { "when": "phone",  "then": "column" },
      { "when": "tablet", "then": "column" }
    ],
    "default": "row"
  }
}
```

`$viewport` also exposes `orientation`, `width` and `height`. Preview the result with the viewport selector's **Phone / Tablet / Laptop** presets before you ship.

A few patterns worth reaching for:

- **Collapse the sidebar on small screens** — bind the region's **Overlay** and **Default state** to `$viewport`, and put a **Menu Toggle Button** in the header.
- **Hide detail rather than shrink it** — bind a widget's `visible` to `$compare` against `$viewport`'s `width`. A cramped widget reads worse than an absent one.
- **Scale, don't redesign, for an odd panel** — the shell's HMI scale factor handles a 7" panel or a 4K wall display without touching a single layout field.
