# Building your own widgets

When the catalog stops, TypeScript starts. Drop a `.tsx` file into your project's `custom-widgets/` folder and the backend compiles it on save and hot-swaps it into the running app — no core rebuild, no Node toolchain, no page reload.

## The folder contract

Each widget is a folder under the project's `custom-widgets/`:

| File | Role |
|---|---|
| `<Name>/index.tsx` | Your source. Exports the default component, and optionally `schema` and `exportedProperties`. |
| `<runtime-home>/.widget-build/…/index.js` | Generated runtime cache — never edit or copy into the project. |
| `<Name>/style.css` | Optional stylesheet, injected on mount, removed on unmount. |
| `<Group>/<Name>/…` | Nest a folder to group widgets in the Add-widget menu. |

Folders starting with `.` or `_` are ignored — keep a scaffold in `_template/` without it being picked up.

## Write one

1. **Create the file** — Add `custom-widgets/SpeedTile/index.tsx`. **Do not import React or app modules** — every hook and helper is handed to you as an SDK global on `window.__nextHMI__`. Just reference the names.
2. **Read properties & data with SDK hooks** — Resolve a schema field with `usePropString` / `usePropNumber` / `usePropVar`, subscribe to a tag with `useVariable` / `useStructVariable`, and write with `useWriteVariable`.
   - Writing back is one call: `const write = useWriteVariable(properties, 'variable')`, then `write(value)` from your handler. It reports a rejected write to the operator for you. Gate your control on `write.canWrite` — only a `$var` binding can be written to, so a property bound to a fixed or computed value resolves fine for display but has nothing to write to, and an enabled control would swallow the click.
3. **Honour the editor's layout** — Spread `selfLayoutStyle(layout)` on your outer element so the editor's basis/grow/min-size fields take effect, and `widgetColorStyle(color)` to let a colour field override the theme.
4. **Declare a schema** — Export a `schema` so your fields show up in the properties panel, and `exportedProperties` so siblings can read your state via `$widgetProp`. Both are read out of your source at compile time, so keep them plain literals; if they can't be read, the widget still renders but the Admin area marks it **No schema** and the editor offers no fields for it.
5. **Save** — The compiler builds the module and pushes a `widget_updated` message over the WebSocket; the editor re-imports it live.

```
// no imports — SDK names come from window.__nextHMI__
export default function SpeedTile({ properties, layout }: HmiWidgetProps) {
  const label = usePropString(properties, 'label', 'Speed')
  const rpm   = useVariable('LinePLC:Motor1/Speed')

  return (
    <div className="speed-tile" style={selfLayoutStyle(layout)}>
      <span className="lbl">{label}</span>
      <strong>{rpm ?? '—'}</strong>
    </div>
  )
}

// fields shown in the editor's properties panel
export const schema = { label: { type: 'string', label: 'Label' } }
```

## Start from a built-in widget

Every widget in the catalog is authored against the *same* SDK as yours — same globals, no imports, same `schema` contract. So the shortest route to a new widget is usually to copy the built-in that already does most of the job.

Their sources live in the NEXT HMI source tree under `frontend/widgets/<Group>/<Name>/`, not in your project folder: an install ships only the compiled module, with no source map. Browse them on GitHub at [mpnvdlee/next-hmi → `frontend/widgets`](https://github.com/mpnvdlee/next-hmi/tree/main/frontend/widgets), and check a widget's fields in the [widget catalog](catalog.md) before you commit to copying it.

To adapt a copy:

1. **Copy the folder** into `custom-widgets/<NewName>/`, `style.css` included.
2. **Rename the CSS class prefix** — `hmi-progress-bar` → `hmi-speed-tile` in both files. Built-in class names are global, so a copy that keeps them fights the original wherever both land on a page. Leave the root selector chained as `.hmi-component.hmi-<your-name>`: a stylesheet injected at runtime can't rely on load order, so it has to win on specificity.
3. **Keep the `var(--hmi-*)` tokens.** They are what makes the widget follow the operator's theme — swap them for literal colours and it stops tracking.
4. **Trim the schema** to the fields you actually want, rename the default export, and save. It compiles like any other custom widget.

Worth starting from: `Indicators/ValueDisplay` for a formatted readout, `Inputs/Switch` for a control that writes back, `Indicators/RingGauge` for SVG drawing, `Content/TrendChart` for a Recharts plot.

## What the SDK gives you

Every name below is a global — no import, ever.

- **React primitives** — `React`, `useState`, `useEffect`, `useMemo`, `useCallback`, `useRef`, `createPortal`.
- **Data & writes** — `useVariable`, `useStructVariable`, `useVariableMeta`, `useBindingValue`, `useWriteVariable`, `useEvalContext`, and `sendWsMessage` for frames that aren't variable writes.
- **Property resolvers** — `usePropString` / `usePropNumber` / `usePropBoolean`, `usePropVar`, `usePropStruct`, `useRecordListProp`, and the non-hook `getProp*` variants for use inside callbacks.
- **Styling** — `selfLayoutStyle`, `widgetColorStyle`, `useCssVar`, `useHmiScope`.
- **Cross-widget props** — `usePublishWidgetProp`, so a sibling can read your state through `$widgetProp`.
- **Workspace data** — `useUsersData`, `useUserGroupsData`, `useLanguagesData`.
- **Navigation** — `useNavigateToPage`, `usePageGroup`, `usePageTitle`, `useVisiblePages`.
- **Actions** — `executeWidgetActions`.
- **Recipes** — `useRecipeConfig`, `useRecipeState`, `recipeDownload`, `recipeUpload`.
- **Icons** — `getBuiltinIconComponent`, `isBuiltinIconId`.
- **Charts** — `Recharts` (`LineChart`, `XAxis`, …) for custom trends and plots.
- **Virtual input** — `VirtualKeyboard` and `VirtualNumpad` for touch panels, plus `CloseButton`.

## Reach for a third-party library

Drop an ESM bundle into the project's `external-libraries/` folder and import it by name through the generated import map — again, no core rebuild. Naming convention and the override file are in [Files & assets](files.md#add-a-third-party-library).

> [!NOTE]
> Type declarations for the whole SDK live in `frontend/custom-widgets-sdk.d.ts`. Reference it from your project's `tsconfig` and you get full editor completion for every global. The SDK carries its own version number, bumped only when a name is removed or a signature changes — additions don't move it.

The full contract — schema fields, styling tokens, struct and array binding shapes, action triggering, and testing — is in the [custom-widget reference](../dev/reference/custom-widgets.md).
