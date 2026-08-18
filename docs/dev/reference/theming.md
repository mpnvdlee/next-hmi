# NEXT HMI Theming & Style Guide

This is the single source of truth for the theme-token catalog, the theme token
pipeline, and the styling conventions and shared UI primitives used in the
codebase. The on-disk theme files (`themes/<id>.json`, one per theme) live in
[../architecture/data-formats.md](../architecture/data-formats.md); the
`/api/themes` endpoints in [rest-api.md](rest-api.md).

Scope note:
- This file is the implementation-focused style source of truth.
- Visual direction guidance is captured directly in this style guide.

## Naming Conventions

- `hmi-*`
  - runtime/operator UI selectors
- `cfg-*`
  - config/editor/admin UI selectors

Several HMI built-ins also use CSS Modules for component-local styling, while still relying on shared `hmi-*` base classes from `frontend/src/hmi/styles/hmi.css`.

## Theme Tokens

HMI runtime CSS variables (`--hmi-*`) exposed to custom components and driven by the theme
editor.

Single source of truth:

- `frontend/src/shared/themeDefaults.json` — default values, read by both the backend Pydantic
  models (`backend/models/theme.py`) and the frontend registry.
- `frontend/src/shared/utils/themeTokens.ts` — `THEME_TOKENS` registry. Each entry carries the
  CSS variable name, theme JSON path, label, description, sample usage, and the editor UI
  metadata (input type, group, placeholder, min/max/step). Also exports `defaultTheme()`,
  `themeSections()`, and `applyThemeTokens()`.

Defaults auto-apply on module load (so the very first paint already has the design palette);
the active project theme (from the `/api/themes` index) overrides them via inline styles on `:root`.

#### Colors — edit in Theme Editor → Colors

| Token | Controls | Theme JSON path | Sample usage |
| ------ | ------ | ------ | ------ |
| `--hmi-bg` | Main background | `colors.bg` | `background: var(--hmi-bg);` |
| `--hmi-surface` | Card/panel background | `colors.surface` | `background: var(--hmi-surface);` |
| `--hmi-surface-raised` | Elevated surface | `colors.surface_raised` | `background: var(--hmi-surface-raised);` |
| `--hmi-text` | Primary text | `colors.text` | `color: var(--hmi-text);` |
| `--hmi-text-muted` | Secondary text | `colors.text_muted` | `color: var(--hmi-text-muted);` |
| `--hmi-accent` | Brand/action accent | `colors.accent` | `border-color: var(--hmi-accent);` |
| `--hmi-border` | Default border | `colors.border` | `border: 1px solid var(--hmi-border);` |
| `--hmi-ok` | Success state | `colors.ok` | `color: var(--hmi-ok);` |
| `--hmi-warn` | Warning state | `colors.warn` | `color: var(--hmi-warn);` |
| `--hmi-fault` | Error/fault state | `colors.fault` | `color: var(--hmi-fault);` |

#### Typography — edit in Theme Editor → Typography

Typography has seven reusable combos: `heading`, `subheading`, `body`,
`caption`, `code`, `value`, and `label`. Every combo has the same five fields,
so the code registry generates them rather than maintaining 35 independent
definitions:

| Suffix | CSS variable | Theme JSON path | Controls |
| ------ | ------------ | --------------- | -------- |
| `font` | `--hmi-type-<combo>-font` | `typography.<combo>_font` | Font family |
| `size` | `--hmi-type-<combo>-size` | `typography.<combo>_size` | Font size |
| `weight` | `--hmi-type-<combo>-weight` | `typography.<combo>_weight` | Font weight |
| `tracking` | `--hmi-type-<combo>-tracking` | `typography.<combo>_tracking` | Letter spacing |
| `transform` | `--hmi-type-<combo>-transform` | `typography.<combo>_transform` | Text case |

For example, label tracking is `--hmi-type-label-tracking` backed by
`typography.label_tracking`.

#### Spacing, radius & shadow — edit in Theme Editor → Spacing

| Token | Controls | Theme JSON path | Sample usage |
| ------ | ------ | ------ | ------ |
| `--hmi-space-sm` | Small spacing | `spacing.space_sm` | `gap: var(--hmi-space-sm);` |
| `--hmi-space-md` | Medium spacing | `spacing.space_md` | `padding: var(--hmi-space-md);` |
| `--hmi-space-lg` | Large spacing | `spacing.space_lg` | `padding: var(--hmi-space-lg);` |
| `--hmi-radius-sm` | Small radius | `spacing.radius_sm` | `border-radius: var(--hmi-radius-sm);` |
| `--hmi-radius` | Default radius | `spacing.radius_md` | `border-radius: var(--hmi-radius);` |
| `--hmi-radius-lg` | Large radius | `spacing.radius_lg` | `border-radius: var(--hmi-radius-lg);` |
| `--hmi-shadow` | Elevation shadow | `spacing.shadow` | `box-shadow: var(--hmi-shadow);` |

> Runtime structural constants (nav width, topbar height, select height) are **not** theme
> tokens. They are defined in `hmi.css` and component CSS files and are not editable in the
> Theme Editor.

> **Input padding is not one of them.** `--hmi-input-padding-x/-y`, `--hmi-input-gap` and
> `--hmi-select-padding-x/-y` are derived from `--hmi-space-sm` in `hmi.tokens.css`, so a
> theme that changes density carries the input controls with it. `--hmi-select-height`
> stays structural: it is a hit target, not padding.

##### Sub-step spacing (derived, not editable)

Below `--hmi-space-sm`, for optically-joined pairs — a value and its unit, a dot and its
label — where a full step reads as two separate items. Fractions of `--hmi-space-sm`, so
they track a theme that changes density. Use one instead of a literal `2px`/`4px`/`6px`.

| Token | Recipe |
| ------ | ------ |
| `--hmi-space-hair` | `--hmi-space-sm × 0.25` |
| `--hmi-space-tight` | `--hmi-space-sm × 0.5` |
| `--hmi-space-snug` | `--hmi-space-sm × 0.75` |

#### Removed: the back-compat aliases

`hmi.tokens.css` used to carry a layer of legacy token names that resolved onto
the current combos. **That layer is gone** — the names below no longer resolve,
and a stylesheet still using one gets an invalid value, so the declaration is
dropped and the property falls back to whatever it inherits. Rewrite against the
right-hand column:

| Removed | Use instead |
|---|---|
| `--hmi-font` | `--hmi-type-body-font` |
| `--hmi-font-mono` | `--hmi-type-code-font` |
| `--hmi-text-xs`, `--hmi-text-sm` | `--hmi-type-caption-size` |
| `--hmi-text-base`, `--hmi-text-md`, `--hmi-font-size-base` | `--hmi-type-body-size` |
| `--hmi-text-lg` | `--hmi-type-subheading-size` |
| `--hmi-text-xl` | `--hmi-type-heading-size` |
| `--hmi-fw-normal` | `--hmi-type-body-weight` |
| `--hmi-fw-medium` | `--hmi-type-subheading-weight` |
| `--hmi-fw-bold` | `--hmi-type-heading-weight` |
| `--hmi-space-xs`, `--hmi-space-1`, `--hmi-space-2` | `--hmi-space-sm` |
| `--hmi-space-3` | `--hmi-space-md` |
| `--hmi-space-4` … `--hmi-space-8` | `--hmi-space-lg` |
| `--hmi-shadow-sm`, `--hmi-shadow-md`, `--hmi-shadow-lg` | `--hmi-shadow` |
| `--hmi-header-h` | `--hmi-topbar-height` |

The aliases were lossy, which is why they went: `--hmi-text-xs` and
`--hmi-text-sm` both landed on the caption size, and none of the type aliases
carried a combo's `tracking` or `transform` — so a theme could change those and
nothing using an alias would move.

For gaps finer than `--hmi-space-sm`, use the sub-step scale rather than a
literal: `--hmi-space-hair`, `--hmi-space-tight`, `--hmi-space-snug` (a quarter,
a half and three quarters of `--hmi-space-sm`).

Motion is no longer editable. `--hmi-motion-fast` (120ms), `--hmi-motion-base` (180ms),
and `--hmi-motion-slow` (260ms) are static constants in `hmi.tokens.css` so transitions
still animate.

<!-- TOKENS:END -->

## Theme Token Pipeline

This is the single source of truth for how theme values flow from disk to the
running UI. The on-disk `themes/<id>.json` shape and the `/api/themes` endpoints
are documented in [../architecture/data-formats.md](../architecture/data-formats.md)
and [rest-api.md](rest-api.md) respectively; this section owns the token catalog
and the apply mechanism.

1. **Shared defaults** — `frontend/src/shared/themeDefaults.json` is the single
   default source. The backend reads it via `_DEFAULTS` in
   `backend/models/theme.py` (Pydantic `default_factory`); the frontend imports
   it into `THEME_TOKENS` in `frontend/src/shared/utils/themeTokens.ts`. To add
   or change a default, edit the JSON only.
2. **Module-load apply** — `themeTokens.ts` calls `applyThemeTokens(DEFAULT_THEME)`
   at module init so the first paint already has the design palette before
   `/api/themes` resolves.
3. **Runtime override** — `loadAndApplyThemeTokens()` fetches the `/api/themes`
   index, caches every theme (`loadedThemes`), and applies the active theme — or
   the project default — over the defaults via inline styles on `:root`.
3a. **Runtime switching** — themes are multiple and named. The operator can switch
   the applied theme in-session via `applyThemeById()` (driven by
   `hmi/store/themeRuntimeStore.ts`); the choice is ephemeral and a reload returns
   to the project's default theme. The backend only tracks the default pointer
   (`config.json` → `project.defaultTheme`, set via `PUT /api/default-theme`).
4. **Token registry** — `THEME_TOKENS` is the single registry. Each entry carries
   the CSS variable, theme JSON path, label, description, sample usage, and the
   editor UI metadata (`section`, `inputType`, `group`, `wide`, `placeholder`,
   `min`/`max`/`step`). `themeSections()` derives the Theme Editor layout from it;
   `defaultTheme()` returns a fresh clone for Reset / import.
5. **Derived secondaries** — `frontend/src/hmi/styles/hmi.tokens.css` derives
   `--hmi-surface-2/3`, `--hmi-text-2/3/4`, `--hmi-border-strong`,
   `--hmi-accent-soft/ink/on`, `--hmi-{ok,warn,fault}-soft` via `color-mix()` from
   the primaries (see the table below). CSS-only — not in the editor.
6. **Cross-tab sync** — `LS_THEME_PREVIEW` (live editor preview, consumed by
   `PreviewView`) and `LS_THEME_SAVED` (post-save refresh, consumed by `HmiView`)
   localStorage keys signal theme changes between browser tabs. `ThemeSection` is
   typed `'colors' | 'typography' | 'spacing'` (lowercase).

## Config Tokens

Defined in `frontend/src/config/styles/config.tokens.css`, which is the
authority — **that file defines ~153 tokens; the list below is the ~38-token
core, not the full set.** Check the file before inventing a value: the
undocumented remainder is mostly component-scoped families that already cover
what a new config component needs.

| Family | Count | Covers |
| ------ | ------ | ------ |
| `--cfg-source-*` | 24 | Per-property-source accent colors — one per source, plus `--cfg-source-mixed` for a multi-selection whose widgets disagree (see [Source Color Tokens](#source-color-tokens)) |
| `--cfg-preview-*` | 13 | The canvas preview chrome |
| `--cfg-danger-*` · `--cfg-error-*` · `--cfg-warning-*` · `--cfg-success-*` · `--cfg-info-*` | 23 | State fills, borders and foregrounds, each with soft/strong variants |
| `--cfg-btn-*` · `--cfg-input-*` · `--cfg-select-*` · `--cfg-toggle-*` · `--cfg-check-*` | 18 | Control sizing — heights, padding, gaps |
| `--cfg-text-*` · `--cfg-font-*` · `--cfg-fw-*` | 14 | Type scale, families, weights |
| `--cfg-field-*` · `--cfg-tag-*` · `--cfg-status-*` · `--cfg-page-*` | 15 | Property-panel and tree component internals |
| `--cfg-motion-*` · `--cfg-ease-*` · `--cfg-shadow-*` | 7 | Transitions and elevation |

Note the `--cfg-source-*` family uses the source's **camelCase** key, matching
the `$`-source name — `--cfg-source-urlParam`, `--cfg-source-userGroups`,
`--cfg-source-componentProp` — not a kebab-cased form.

The core, most-used tokens:

- `--cfg-bg`
- `--cfg-surface`
- `--cfg-surface-dark`
- `--cfg-accent`
- `--cfg-accent-hover`
- `--cfg-text`
- `--cfg-text-muted`
- `--cfg-fg`
- `--cfg-fg-muted`
- `--cfg-border`
- `--cfg-bg-secondary`
- `--cfg-bg-hover`
- `--cfg-selected-bg`
- `--cfg-selected-text`
- `--cfg-danger`
- `--cfg-success`
- `--cfg-warning`
- `--cfg-space-1` ... `--cfg-space-8`
- `--cfg-font`
- `--cfg-text-xs`
- `--cfg-text-sm`
- `--cfg-text-base`
- `--cfg-text-lg`
- `--cfg-text-xl`
- `--cfg-font-size-base`
- `--cfg-radius`
- `--cfg-motion-fast`
- `--cfg-motion-base`
- `--cfg-motion-slow`
- `--cfg-focus-outline`
- `--cfg-focus-offset`

## HMI Tokens

Editable primaries (`--hmi-bg`, `--hmi-surface`, `--hmi-text`, fonts, spacing, radii, shadows,
motion) are not declared in CSS. They are written as inline styles on `:root` by
`applyThemeTokens()` — at module load (defaults from `themeDefaults.json`) and again on
`/api/themes` load. See the Theme Tokens table above for the editable list.

`frontend/src/hmi/styles/hmi.tokens.css` holds only:

1. **Derived secondary tokens** — recompute from primaries via `color-mix()` (see table below)
2. **Structural / non-editable tokens** — overlay, modal and toast shadow (a floating
   surface can't take its elevation from the editable `--hmi-shadow`, which a theme may
   set to almost nothing), indicator, virtual-panel
   sizes, the alarm severity stripe, the chart series palette, and the layering scale
   (`--hmi-z-modal` 100 → `--hmi-z-popup` 130 → `--hmi-z-alert` 200 → `--hmi-z-toast` 300
   → `--hmi-z-alarm-dialog` 400) that every runtime overlay reads its `z-index` from.
   `--hmi-z-popup` is the widget-owned layer: a dropdown list or nav flyout escapes its
   scroll container but still belongs to the page
3. **Aliases** referenced by component CSS but not surfaced in the editor —
   `--hmi-radius-full` and the static motion durations

Non-theme structural constants (e.g. `--hmi-topbar-height`, `--hmi-nav-width`) live in
`frontend/src/hmi/styles/hmi.css` and per-component CSS files.

#### Derived secondary tokens (CSS-only, not editable)

These recompute automatically when a primary changes — no editor surface, no JSON entry.

| Token | Recipe | Use for |
| ------ | ------ | ------ |
| `--hmi-surface-2` | `surface 92% + bg` | Panel-on-panel backgrounds, table headers |
| `--hmi-surface-3` | `bg 80% + text 5%` | Hover backgrounds, neutral hover state |
| `--hmi-text-2` | `text 75% + text_muted` | Slightly dimmed body text |
| `--hmi-text-3` | `text_muted` | Standard secondary/helper text |
| `--hmi-text-4` | `text_muted 70% + bg` | Disabled / placeholder text |
| `--hmi-border-strong` | `border 55% + text` | Stronger dividers, button outlines |
| `--hmi-accent-soft` | `accent 12% + surface` | Tinted background for active rows / pills |
| `--hmi-accent-ink` | `accent 80% + black` | Hover/pressed accent fill, active text |
| `--hmi-accent-on` | `--hmi-white` | Foreground on solid accent surfaces |
| `--hmi-ok-soft` | `ok 14% + surface` | Soft fill for OK pills / rows |
| `--hmi-warn-soft` | `warn 16% + surface` | Soft fill for warn pills / rows |
| `--hmi-fault-soft` | `fault 14% + surface` | Soft fill for fault pills / rows |
| `--hmi-info` | fixed `#0a84ff` | Informational status — info alarms, info toasts. Not theme-editable, so "info" stays blue under any accent |
| `--hmi-info-soft` | `info 12% + surface` | Soft fill for info pills / rows |
| `--hmi-info-ink` | `info 80% + black` | Info text on a soft info fill |

#### Chart series palette (fixed, not editable)

`--hmi-series-1` … `--hmi-series-8` — eight categorical hues for multi-trace plots, in
draw order. Fixed for the same reason as `--hmi-info`: a series colour carries identity,
not status, so the set has to stay mutually distinguishable. Deriving it from the accent
would pull every trace towards one hue and make an eight-tag trend unreadable.

| Token | Value | Token | Value |
| ------ | ------ | ------ | ------ |
| `--hmi-series-1` | `#2563eb` | `--hmi-series-5` | `#7c3aed` |
| `--hmi-series-2` | `#dc2626` | `--hmi-series-6` | `#0891b2` |
| `--hmi-series-3` | `#16a34a` | `--hmi-series-7` | `#be185d` |
| `--hmi-series-4` | `#d97706` | `--hmi-series-8` | `#65a30d` |

`var()` resolves in an SVG presentation attribute, so a chart can hand these straight to
a `stroke` — `stroke="var(--hmi-series-1)"` — and re-paint on a theme switch with no
JavaScript. The built-in Trend Chart does exactly that, and lets an author override the
whole palette per instance with its `seriesColors` property.

## HMI Primitives

Reusable utility classes in `frontend/src/hmi/styles/hmi-primitives.css`. Available globally
inside the runtime so built-in components and user widgets can opt in.

| Class | Purpose |
| ------ | ------ |
| `.hmi-pill` + `.hmi-pill__dot` | Status pill with `--ok / --warn / --fault / --idle / --accent` modifiers |
| `.hmi-live-dot` | Pulsing indicator dot with `--warn / --fault / --idle` modifiers |
| `.hmi-kicker` | Uppercase eyebrow label (small caps with letter-spacing) |
| `.hmi-readout` | Numeric readout — mono font, tabular nums, weight bold |
| `.hmi-bar` + `.hmi-bar__fill` | Linear progress bar with `--ok / --warn / --fault` modifiers |

## Focus and Accessibility

Config controls use a shared keyboard focus style from `frontend/src/config/styles/config.css`.

- Use `:focus-visible` for keyboard focus states.
- Reuse `--cfg-focus-outline` and `--cfg-focus-offset` instead of hard-coded outlines.
- Apply this pattern to interactive controls (`button`, `input`, `select`, tree action buttons, modal actions) to keep behavior consistent.

## Config UI Component Organization

All config UI components live in `frontend/src/config/components/` and follow these rules:

- Components are grouped by area in subfolders: `admin/`, `editor/`, `translations/`, `users/`, `variables/`, `shell/`, `ui/`, and `shared/`
- Each component lives in its **own folder** (`ComponentName/index.tsx` + `ComponentName/style.css`)
- Per-component CSS must be kept as small as possible — reuse classes from `config.css` instead of duplicating styles
- The `styles/` folder contains `config.css` (layout, primitives, utility classes) and `config.tokens.css` (config design token variables); no other shared or per-page stylesheets belong there
- **Pages have no CSS files.** A page (`config/pages/*.tsx`) must be composed entirely from components. All styles belong in the components used by that page

## Shared Config Components

### Button

Component path:

- `frontend/src/config/components/ui/Button/index.tsx`

Supported variants:

- `default`
- `primary`
- `danger`
- `success`
- `neutral`
- `accent`
- `ghost`
- `icon`

Supported sizes:

- `md`
- `sm`

Applied classes:

- `cfg-btn`
- `cfg-btn--primary`
- `cfg-btn--danger`
- `cfg-btn--ghost`
- `cfg-btn--icon`
- `cfg-btn--sm`
- `cfg-btn--full`

### PropRow

Component path:

- `frontend/src/config/components/ui/PropRow/index.tsx`

Wraps `FieldGroup` for ordinary property rows and supplies the static-source
badge unless the field is explicitly marked sourceless.

### ConfigLayout

Component path:

- `frontend/src/config/components/ui/ConfigLayout/index.tsx`

Implements the three-panel config layout with resize handles.

Default panel sizing:

- left: `260px`
- right: `340px`
- min panel width: `200px`
- max panel width: `600px`

Used classes:

- `cfg-layout`
- `cfg-sidebar`
- `cfg-center`
- `cfg-props-panel`

## Color Input

Component path:

- `frontend/src/config/components/editor/ColorInput/index.tsx`

Realizes the panel-wide themed-default/override model for colors:

- **Unset** follows the theme — reads `Theme · <label>` when a `defaultToken`
  is given, else `Default`.
- Picking a **theme token** pins the value to `var(--hmi-*)` so it re-skins
  with the theme.
- Picking a **suggested / custom color** sets a fixed hex that does not
  re-skin.
- The `×` in the field's `FieldActions` column reverts an override back to
  following the theme.

The popup is a single scrollable list — Default, theme tokens, suggested
colors, custom — not a tabbed picker; it floats (`position: fixed`) so the
field box's `overflow: hidden` can't clip it.

Key classes:

- `cfg-color-picker`, `cfg-color-picker__label`, `cfg-color-picker__swatch`
  (+ `--default`, `--selected` modifiers)
- `cfg-color-picker__popup`, `cfg-color-picker__options`,
  `cfg-color-picker__option` (+ `--custom`, `--selected` modifiers),
  `cfg-color-picker__option-name`, `cfg-color-picker__option-hex`,
  `cfg-color-picker__divider`
- `cfg-color-picker__custom-row`, `cfg-color-picker__input`,
  `cfg-color-picker__close`

The same themed-default/override affordance (unset hint + revert) extends to
other field types via `resolveDefaultDisplay`'s `defaultToken` support —
multiline/password/date/time/duration/percentage text fields, `LayoutFields`
rows, and `BoolButtonGroup`/segmented selects (which dim the option the
schema/theme default resolves to instead of coercing `undefined` to `false`).

## Property Panel Field Shell — FieldGroup

Component path:

- `frontend/src/config/components/ui/FieldGroup/index.tsx`

The shared shell every schema-driven property row renders through — badge,
label, collapsed preview, `FieldActions` slot, expand/collapse, drawer
pop-out, and selection highlighting all live here instead of being
reimplemented per field. Three **content tiers** (`FieldGroupTier`, `1 | 2 | 3`)
control layout:

- **Tier 1** — plain leaf value, renders inline (no box).
- **Tier 2** — a short structured value (e.g. a two-part condition), boxed but
  always expanded.
- **Tier 3** — a composite/nested value (e.g. `$if`, an action, a struct
  binding); boxed, collapsible, and can pop out into a `FieldDrawer` via the
  `⤢` expand-in-drawer action.

Tier-3 expand/collapse state is **session-scoped**, not per-render: every
tier-3 field and `CollapsibleSection` starts collapsed on page load and
remembers what the user opens for as long as the page stays open, via
`frontend/src/config/store/panelExpansionStore.ts` (a `PanelScopeContext` id
— the owning component/composition — plus the field's identity as the store
key). A `FieldDrawer` copy of a field uses a `::drawer`-suffixed scope so its
always-open state never collides with the inline row's session key.

`FieldActions` (exported from the same module) is the shared flush-right
button column — clear/revert/edit buttons for a field portal here instead of
floating inline in the field's content, so every row's action affordance
lines up in one column.

`FieldHeaderActions` (same module) is the counterpart on the **title row**: a
list editor's add control portals behind the field's label instead of trailing
the list, matching the action list, the component-property list and the
historian's tracked variables. Both slots come from a context the group
publishes, and both fall back to rendering in place — `FieldActions` when
there is no `FieldGroup` ancestor at all, `FieldHeaderActions` when there is
no *labelled* one, since an unlabelled group has no title row to portal into.
An unlabelled group forwards whatever slot it inherited rather than
publishing its own, so nesting one inside a labelled group is transparent.

Key classes:

- `cfg-field-group`, `cfg-field-group--tier{1,2,3}`, `--selected`,
  `--sourceless`, `--invalid`
- `cfg-field-group__row` (+ `--block`), `cfg-field-group__box`,
  `cfg-field-group__content`, `cfg-field-group__nest`
- `cfg-field-group__header`, `cfg-field-group__header-actions`
- `cfg-field-group__label`, `cfg-field-group__desc`,
  `cfg-field-group__badge` (+ `--invalid`, `--warning`),
  `cfg-field-group__badge-cap`, `cfg-field-group__actions`
- `cfg-field-group__preview`, `cfg-field-group__preview-text` (+ `--mono`),
  `cfg-field-group__preview-swatch`

An invalid/unresolved binding is marked two ways: the badge shows a corner
dot (`--invalid`), and the value text itself reads in `--cfg-danger` with a
dotted underline (`--invalid` on the group), so the error is visible whether
the field is a leaf path or a collapsed summary.

Sibling shell pieces:

- `CollapsibleSection` (`frontend/src/config/components/ui/CollapsibleSection/index.tsx`,
  classes `cfg-section`, `cfg-section__header`, `cfg-section__title`,
  `cfg-section__arrow` (+ `--open`)) — the click-to-collapse section header
  used for panel groups like "Properties" / "Visibility" / "Layout". Shares
  the same session expand store as `FieldGroup`.
- `FieldDrawer` (`frontend/src/config/components/editor/PropertiesPanel/FieldDrawer.tsx`) —
  the pop-out panel a tier-3 `FieldGroup` opens into.
- `useCommittableDraft` (`frontend/src/config/hooks/useCommittableDraft.ts`) —
  draft-until-blur text input state, so typing doesn't commit a value (and
  re-render the tree) on every keystroke.

## Property Source / Action / Glyph Icons

Hand-authored inline SVG icon sets, one visual language shared across the
panel:

- `frontend/src/config/components/ui/glyphIcon.tsx` — base `GlyphIcon` (stroke
  width, viewBox) plus shared glyph path fragments (`BoltGlyphPath`,
  `GlobeGlyphPaths`) reused by multiple icon sets.
- `frontend/src/config/components/editor/PropertySourceSelector/propertySourceIcons.tsx` —
  one icon per `PropertySource` (`$static`, `$var`, `$if`, `$userGroups`, …),
  shown on the source-select badge.
- `frontend/src/config/components/editor/PropertiesPanel/actionTypeIcons.tsx` —
  one icon per `ButtonAction['type']`, `ActionTypeBadge` renders it tinted via
  `--option-color` to the action's `ACTION_TYPE_TINT` color (see below).
- `frontend/src/config/components/ui/actionIcons.tsx` — small generic action
  glyphs (`ClearIcon`, `EditIcon`, `ChevronIcon`, `ExpandIcon`) used across
  `FieldActions` columns and expand affordances.

## Source Color Tokens

`--cfg-source-<source>` in `config.tokens.css` (e.g. `--cfg-source-if`,
`--cfg-source-userGroups`) is the tint for a given property source / action
kind. Consumers apply it through a `--option-color` custom property rather
than a hard rule per kind — see `Kw` in
`frontend/src/config/components/editor/PropertySourceEditor/editors/shared.tsx`
and `.kw { color: var(--option-color, inherit); }` in
`FieldGroup/style.css` — so a collapsed preview's keyword (`if(`, `switch(`,
`random(`, an action summary's verb) and its badge always share one color per
kind without a growing `data-kind` switch.

## Property Source Editor UI

The source-aware property controls in the editor use these classes:

- `cfg-source-pill` (+ `--single`, `__abbr`, `__label`, `__arrow`, `__popup`,
  `__option`, `__option--active`, `__option-label`, `__browse`) — the pill
  trigger and its popup, in `PropertySourceSelector/style.css`
- `cfg-source-pill-wrapper` — positioning host for the popup
- `cfg-property-source-badge` — the coloured glyph chip (pill and `FieldGroup`
  badge-cap variants)
- `cfg-property-source-card`, `cfg-property-source-card__key` — the browse
  drawer's source cards
- `cfg-property-source-editor__static` — the static sub-editor slot

## Tree UI System

The shared tree styles live in `frontend/src/config/styles/config.css` and are used across config views.

Core classes:

- `cfg-tree`
- `cfg-tree__scroll`
- `cfg-tree-item`
- `cfg-tree-item--selected`
- `cfg-tree-item--group`
- `cfg-tree-item__toggle-slot`
- `cfg-tree-item__icon`
- `cfg-tree-item__label`
- `cfg-tree-item__row-btn`
- `cfg-tree-item__count`

Tree indentation is driven by the `--tree-depth` CSS custom property.

For virtualized tree row indentation math in TS, use shared helper utilities in `frontend/src/config/utils/treeRowLayout.ts`.

- `treePaddingLeft(depth, options?)`
- `treePaddingLeftWithOffset(depth, offset, options?)`

Do not duplicate literal indentation formulas in renderers; prefer these helpers so picker/table row alignment stays consistent.

## Runtime Layout Helpers

Runtime components and custom components rely on helpers from `frontend/src/hmi/components/layoutUtils.ts`:

- `selfLayoutStyle(layout)`
- `containerLayoutStyle(layout)`
- `widgetColorStyle(color)`

These helpers are the supported path for applying layout-related inline styles and optional configured background colors.
