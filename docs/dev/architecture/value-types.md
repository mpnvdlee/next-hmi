# Property Value Types

Every property value answers two questions:

1. **What type is it?** — the kind of value (`String`, `Integer`, `Byte`, `Float`, `Boolean`, `DateTime`, `Date`, `Time`, `Duration`, `color`, `icon`, `image`, `video`). Any type can also be an **array** of that type.
2. **Where does it come from?** — the source (a literal you typed, a datasource variable, the logged-in user, a computed expression, …).

The **type is decided by the field**. A label's `text` field needs a `String`; a gauge's `value` field needs a `Float` or an `Integer`. You don't pick the type — you pick a **source** that produces the type the field wants.

```
property value = a SOURCE that produces the TYPE the field needs
```

A value is either a raw primitive (`"hello"`, `42`, `true`) or a `$`-keyed object that names its source.

---

## Types

The kinds of value a field can hold. Any of these can also appear as an **array** (e.g. a list of strings) for fields that take multiple values.

| Type | Looks like | Used for |
|---|---|---|
| `String` | `"hello"` | Text, labels, captions |
| `Integer` | `42` | Whole-number values, counts, indices |
| `Byte` | `12` | A whole number 0–255 from an OPC-UA `Byte` (Siemens `BYTE` / `USINT`). Exact like every base: only fields that list it take one — `$formula` operands and Value Display's `variable` |
| `Float` | `3.14` | Continuous values, sizes, measurements |
| `Boolean` | `true` / `false` | Visibility, enabled, toggles |
| `DateTime` | `"2026-06-16T14:30:00Z"` | Timestamps, date + time values |
| `Date` | `"2026-06-16"` | Calendar dates (no time) |
| `Time` | `"14:30:00"` | Times of day (no date) |
| `Duration` | `"PT1H30M"`, `5400` | Spans of time, elapsed/remaining |
| `color` | `"#ff0000"`, `"var(--accent)"` | Colors, fills, strokes |
| `icon` | `{ type, name }` | Icon pickers |
| `image` | `{ path }` | Image from `assets/images/` |
| `video` | `{ path }` | Recorded video from `assets/videos/` |

### Formats (subtypes)

The types above are the *runtime* kinds. A field may also declare an **optional format** that refines a base type without changing it — it only drives editor affordances (which picker/validator to show). A field with no format just gets the default editor for its base type; a format only *upgrades* that editor. The set is **open-ended** — new formats are added when a value (already valid as its base type) deserves a richer picker:

| Base type | Format | Editor shows |
|---|---|---|
| `String` | `url` | A URL field with validation |
| `String` | `multiline` | A multi-line text area |
| `String` · `Integer` · `Float` · `Boolean` | `select` | A dropdown of allowed values. The base type is whatever the options hold, so a numeric option list accepts numeric sources. A component property declares that with `optionType` (`string` \| `integer` \| `float` \| `boolean` \| `loc`, absent = `string`); `loc` options hold `{ $loc }` values and still resolve to `String` |
| `String` | `password` | A masked input |
| `String` | `length` | A CSS size input (`300px`, `50%`, `auto`) |
| `String` | `direction` | A `row` \| `column` \| `stack` picker |
| `String` | `align` | A cross-axis alignment picker (`start`, `center`, `end`, `stretch`, …) |
| `String` | `justify` | A main-axis alignment picker (`start`, `center`, `end`, `space-between`, …) |
| `String` | `page` | A dropdown of the project's **navigable** pages (stores the page id). The Dialogs folder is left out — nothing routes to one, so naming it would author a dead target; a page id already stored from there stays listed, marked *not navigable* |
| `String` | `variables` | One row per variable key, each picked and reordered on its own; stored comma-separated. Like `actions`, the group takes no source pill — every row is its own property row |
| `Float` | `percentage` | A 0–100 input with a `%` affix |
| `Boolean` | `visibility` | A **Visible / Hidden** toggle |
| `Boolean` | `enablement` | An **Enabled / Disabled** toggle |
| `Boolean` | `wrap` | A **Wrap / No wrap** toggle |
| `Boolean` | `show` | A **Show / Hide** toggle |
| `Boolean` | `expansion` | An **Expanded / Collapsed** toggle |
| `Boolean` | `collapse` | A **Collapsed / Expanded** toggle — `expansion` read from the other end, for a property that is `true` when collapsed |
| `Boolean` | `onoff` | An **On / Off** toggle |

A boolean with no format gets a **Yes / No** toggle. A boolean format only relabels the two states (`BOOLEAN_FORMAT_LABELS` in `frontend/src/config/utils/renderSchemaField.tsx`, the `true` label first); the stored value is still `true` / `false`, and every boolean source still works unchanged.

A value's source rules are decided by its **base type** — format is purely a UI hint. `option-list` is just "an array of a base type" with a list editor; it is not a separate type.

---

## Sources

Two kinds of source, by where their type comes from:

- **Flexible** — carries whatever type the field needs (shown as `any`). Usable almost anywhere.
- **Fixed-type** — always produces one specific type. Only valid where the field wants that type. Some of these take an inner `field` selector; once it's pinned, the produced type is fixed (a source whose `field` choices span several types simply appears once per type below).

> **Source availability is decided by the field's *type* alone.** A source is offered only where its produced type is exactly the field's type — an `Integer` producer does not fit a `Float` field, a `Boolean` one not a `String` field, a `String` one not a `DateTime`, `Date` or `Time` field. The one exception is `Duration`, a number of seconds, which an `Integer` or `Float` producer also fills. There is no per-field allowlist, and a schema cannot hand-pick which sources its inputs accept. The field's `type` is the single gate for which sources appear.

The scalar types derive that list from each source's produced type. The editor kinds are not scalars, so theirs is written out per kind in `frontend/src/hmi/utils/propertySourceRules.ts` — `image` and `video` share one list (`$static`, `$var`, `$urlParam`, `$if`, `$switch`, `$widgetProp`), `icon` adds `$page` to it, and `color` drops `$urlParam` from it and adds `$map`. `option-list` (a dropdown's options) takes `$static`, `$user`, `$var`, `$languages` and `$widgetProp`; `record-list` (a data grid's rows) takes `$var`, `$recipeList` and `$widgetProp`; `item-list` (what a Repeater repeats over) takes `$static`, `$var`, `$http`, `$recipeList`, `$user` and `$widgetProp`. `$componentProp`, `$result` and `$repeatItem` are added on top by the editor wherever the surrounding scope offers them, on any type.

### Flexible sources (fit any field)

These carry whatever type the field requires, so you can use them almost anywhere.

| Source | Shape | What it gives you |
|---|---|---|
| `$static` | `{ $static: value }` | A fixed value you type or pick — the literal for **any** type, including a structured `icon` (`{ type, name }`), `image` (`{ path }`) or `video` (`{ path }`). For those, the editor opens a picker rather than a text box |
| `$var` | `{ $var: { path, index?, repeatIndex?, bit? } }` | A live datasource / OPC-UA variable. `repeatIndex: true` takes `index` from the surrounding Repeater copy — see [Repeater items in depth](#repeater-items-in-depth-repeatitem). `index` may itself be an Integer source (`{ $componentProp: 'device' }`, a `$var`): `useResolvedProperties` resolves it to a number before a widget, its writer or an action target sees the binding (`boundIndexResolution.ts`), events resolve a write target's at write time, and a `$var` inside it is subscribed. No whole number from 0 up resolves to `-1`: the read is *absent*, never the whole array, and a write is refused `array_index_out_of_bounds`. A whole array on a field that takes one value — or as a toggle or Edit Value target — is reported at `<field>/$var/index`, where the editor's index row — under the field's box, untitled, with an *Element of the array* hint — asks for the element. `bit` reads one bit (0 the lowest) of a whole number as a `Boolean` — judged as a `Boolean` against the field, its word's access deciding a write; `readBit` in `valueTypes.ts` on the runtime, `_has_bit` in the validator, which caps it at the real type's width (`BIT_WIDTHS`: 8, 16 or 32 for `Byte`/`SByte`, `UInt16`/`Int16`, `UInt32`/`Int32` and a static `Integer`; none for an array element). A write travels with a `.N` path suffix and lands as a read-modify-write of the whole word — see [websocket.md](websocket.md#client--server-messages) |
| `$widgetProp` | `{ $widgetProp: { componentId, property, path? } }` | A property **exported by another component** on the page (sibling → me). `path` is an optional slash-path into a struct/array member of the exported value (e.g. `name` on a selected row) |
| `$componentProp` | `{ $componentProp: name }` | A value **passed in from outside** — by my parent component, or by the action that opened the page overlay I am in (outside → me) |
| `$overlay` | `{ $overlay: { page, param } }` | An input parameter of the Dialogs-folder page `page` **while it is open** — what the opening action passed, else the declared default — and *absent* once it closes. Reads the topmost open copy, from anywhere on screen: a hotspot's selection ring is `$compare($overlay{device, device} === 3)`. The backend flags a `page` outside the Dialogs folder (`overlay-page`) and a `param` it does not declare (`overlay-param-unknown`) |
| `$result` | `{ $result: field }` | An action's result (only inside `onSuccess` / `onFailed` / `onSettled`) |
| `$repeatItem` | `{ $repeatItem: { field?, member? } }` | The element of the surrounding Repeater copy, one `member` of it, or (`field: 'index'`) its 0-based index — see [Repeater items in depth](#repeater-items-in-depth-repeatitem) |
| `$if` | `{ $if: { condition, true, false } }` | One of two values, chosen by a condition |
| `$switch` | `{ $switch: { value, cases[{ when, then }], default } }` | One of many values, chosen by a key |
| `$http` | `{ $http: { url, wildcards?, method?, headers?, body?, path?, refreshSeconds? } }` | A value picked out of an HTTP API response — see [HTTP requests in depth](#http-requests-in-depth-http) |

> **Actions vs. values.** This doc is about *values* a field reads. Actions are the other half — what a control does when triggered (navigate, write a variable, call the backend) — and are covered separately. They touch values in only one place: an async action can run completion handlers (`onSuccess` / `onFailed` / `onSettled`), and inside those, `$result` reads a field from the action's response payload. Outside a handler, `$result` resolves to *absent*.

### Fixed-type sources (locked to one type)

Each of these only works in a field of the matching type.

| Source | Produces | Shape | What it gives you |
|---|---|---|---|
| `$loc` | String | `{ $loc: key }` | Translated text for the current language |
| `$stringExpr` | String | `{ $stringExpr: { template, wildcards } }` | A template like `"Tank {1} of {2}"` |
| `$urlParam` | String | `{ $urlParam: { name, default? } }` | A value from the page URL |
| `$device`, hostname | String | `{ $device: { field } }` `field: hostname` | This machine's network name |
| `$device`, ipAddress | String | `{ $device: { field } }` `field: ipAddress` | This machine's IP address |
| `$device`, macAddress | String | `{ $device: { field } }` `field: macAddress` | This machine's MAC address |
| `$random` | Integer / Float | `{ $random: { min, max, integer? } }` | A random number — whole unless `integer: false`, so it is offered on `Integer` and `Float` fields alike |
| `$alarmCount` | Integer | `{ $alarmCount: { filter } }` | Count of `all` \| `unacked` \| `error` \| `warning` \| `info` alarms |
| `$recipe` | String / Boolean / Float / Integer / DateTime | `{ $recipe: { type, field, parameter?, format? } }` | Scoped to a dataset type: `activeName` (loaded recipe name), `loaded`, or `parametersChanged` (live values differ from the loaded dataset); with a `parameter`, `parameterChanged` (that one live value differs) or `parameterValue` (its stored value, of whatever type the parameter holds); `changedCount` (how many parameters differ) and `savedAt` (when the loaded dataset was saved: ISO, or text in `format` as `$time` writes it) |
| `$recipeList` | Record[] | `{ $recipeList: { type } }` | A dataset type's saved recipes as grid rows `{ id, name, description, lastLoaded }` (empty `type` = all types). Offered on `record-list` fields; read with `useRecordListProp` |
| `$compare` | Boolean | `{ $compare: { left, operator, right } }` | A comparison result (`>` `<` `>=` `<=` `===` `!==`). The ordering operators coerce both sides to numbers, treating a non-numeric side as `0`. `===` / `!==` are **not** strict despite the spelling: `looseEquals` compares identity first, then number-vs-string by `parseFloat`, so `5 === "5"` is `true` while `true === 1` is `false` |
| `$not` | Boolean | `{ $not: { value } }` | The inverse of a boolean `value`. A number counts as a 0/1 flag (`0` → `true`, anything else → `false`); any other input, or none, is *absent* |
| `$and` / `$or` | Boolean | `{ $and: [cond, …] }` / `{ $or: [cond, …] }` | `$and` is `true` when every item is truthy, `$or` when any is; items are Boolean property values of any source, nested `$and` / `$or` included. An empty or non-list payload is `false` (the validator reports `and-empty` / `or-empty` as an error, and a non-list as a structural error) |
| `$formula` | Float / Integer | `{ $formula: { expression, wildcards, round? } }` | Structured-Text-style arithmetic like `({1} - 32) / 1.8` or `SHR({1}, 4) AND 16#0F`: numbers (`16#…` and `2#…` too), `{n}` placeholders filled from `wildcards` (each a full property value, coerced with `toNumber`, a Boolean to 1 / 0) and `{n}.N`, one bit of one; `+ - * /`, unary minus, parentheses, and on whole numbers `AND OR XOR NOT`, `SHL(x, n)`, `SHR(x, n)` — ST precedence, `NOT` tightest and `OR` loosest. A bit operation on a fraction is *absent* too. An unparseable expression, a placeholder with no numeric value, a division by zero or a non-finite result makes the whole value *absent*. `round: true` rounds the result to the nearest whole number (`Math.round`); a formula created on an `Integer`-only field starts with it on, and the backend warns `formula-fraction` when such a field holds one without it. The grammar lives in `frontend/src/hmi/utils/formula.ts`; the backend mirrors it only to flag syntax errors, both held to `frontend/src/shared/types/__fixtures__/formulaSyntax.json` |
| `$pageIsActive` | Boolean | `{ $pageIsActive: { page? } }` | `true` when the target page is active |
| `$languages` | String[] | `{ $languages: {} }` | The project's language list |
| `$user`, username | String | `{ $user: { field } }` `field: username` | The logged-in user's name |
| `$user`, groups | String / String[] | `{ $user: { field } }` `field: groups` | On a text field, the logged-in user's group **labels, comma-joined** into one `String`. On an **`option-list`** field, every group in the project as `{ label, value }` options, valued by group id. For membership tests use `$userGroups`, which is what the `visible` / `interactable` gate uses |
| `$user`, userList | String[] / String | `{ $user: { field } }` `field: userList` | Every user in the project. On an **`option-list`** field it is the options, `{ label, value }` pairs that carry the username as both — `loginUser` signs in by username — and an `option-list` field's `$user` editor offers only `userList` and `groups`. Bound to a text field instead it joins the names with `", "`, since `ResolvedValue` cannot carry an array. The editor offers it on list and text fields, never on a number or boolean |
| `$userGroups` | Boolean | `{ $userGroups: { groups } }` | `true` when the logged-in user is in one of the selected groups (empty `groups` = everyone). The source behind the standard `visible` / `interactable` group gate |
| `$page`, id | String | `{ $page: { field, pageId? } }` `field: id` | The page's id. With no `pageId` this is the page **being rendered**, which inside a page overlay is not the route's — see [Page metadata in depth](#page-metadata-in-depth-page) |
| `$page`, title | String | `{ $page: { field, pageId? } }` `field: title` | The page's title |
| `$page`, icon | String | `{ $page: { field, pageId? } }` `field: icon` | The page's icon name |
| `$page`, description | String | `{ $page: { field, pageId? } }` `field: description` | The page's description |
| `$page`, breadcrumbLabel | String | `{ $page: { field, pageId? } }` `field: breadcrumbLabel` | The page's breadcrumb label |
| `$page`, parentId | String | `{ $page: { field, pageId? } }` `field: parentId` | The id of the page's parent |
| `$page`, pathString | String | `{ $page: { field, pageId?, separator? } }` `field: pathString` | The breadcrumb trail joined by `separator` |
| `$page`, depth | Integer | `{ $page: { field, pageId? } }` `field: depth` | How deep the page sits in the page tree |
| `$page`, pathSegments | String[] | `{ $page: { field, pageId? } }` `field: pathSegments` | The breadcrumb trail to the page |
| `$page`, groupIndex | Integer | `{ $page: { field, pageId? } }` `field: groupIndex` | The page's position among its group's children, from 0. Without `pageId` it is the **active tab of the group around the widget** — the `PageGroupStackContext` entry the tab actions switch, so a group's header or footer reads its own group's tab, not a nested one's. `null` for a page outside any group |
| `$page`, groupLastIndex | Integer | `{ $page: { field, pageId? } }` `field: groupLastIndex` | The last position in that group (children − 1) |
| `$viewport`, size | String | `{ $viewport: { field } }` `field: size` | The size class (`phone`/`tablet`/`laptop`) |
| `$viewport`, orientation | String | `{ $viewport: { field } }` `field: orientation` | `portrait` or `landscape` |
| `$viewport`, width | Integer | `{ $viewport: { field } }` `field: width` | The viewport's pixel width |
| `$viewport`, height | Integer | `{ $viewport: { field } }` `field: height` | The viewport's pixel height |
| `$map` | String / Boolean / Integer / Float / Color | `{ $map: { id, value } }` | `value` looked up in the project value map `id` (config.json `valueMaps`, [data-formats.md](data-formats.md)): evaluated as a `$switch` with the map's `cases` and `default`, so a map without a default is *absent* and an unknown `id` is `null`. It produces the map's type: offered on String, Boolean, Integer and Float fields and on `color`, while its editor lists only the maps whose type fits the field — the same type, or a number in a `Duration` (`valueMapFits`). The backend flags an unset `id` (`map-empty`), an `id` no map has (`map-unknown`) and a map of another type (`map-type`). The editor sends its unsaved maps with each realtime validation, so a new map resolves before the save |
| `$time` | DateTime / String / Date / Time | `{ $time: { format?, timezone? } }` | The current date/time as text formatted by `format` (default `HH:mm:ss`, the ISO time text a `Time` field takes). The format decides which of them the text is, so it is offered on all four |

**A source's `field` choices follow the field it sits in.** What each choice of `$page`, `$viewport`, `$recipe`, `$user` and `$device` yields is one table, `SOURCE_FIELD_PRODUCES` in `frontend/src/hmi/utils/propertySourceRegistry.ts` (held by the fixture `frontend/src/shared/types/__fixtures__/sourceProduces.json`); a source's `produces` is the union of its choices'. The source is offered where at least one choice fits the field, by the same exact rule as any produced type (a boolean choice does not serve a text field, an integer choice does serve a `Duration`), and its Field dropdown lists only the choices that fit: on an `Integer` field `$page` lists `depth`, `groupIndex` and `groupLastIndex` and `$viewport` `width` / `height`; on a `Boolean` field `$recipe` lists `loaded` / `parametersChanged` / `parameterChanged`, and `parameterValue`, which may hold a Boolean. A stored choice that does not fit stays listed, marked, so opening the editor never changes an existing value. A new source starts on its usual choice when that fits, otherwise on the first that does (`$page` on an `Integer` field starts on `depth`). A slot that takes any type — a `$compare` operand, a `$switch` value — lists every choice.

The backend holds a stored value to the same rules (`backend/core/validation/source_rules.py`, a port held equal to the TS by the fixtures `sourceOffers.json` and `sourceProduces.json`): a fixed-type source its field's type does not offer — `$alarmCount` on a `Boolean`, `$random` on a colour — or a stored `field` choice that yields a type the field does not take is a `source-type` error. Only the field's source-capable types count, any one of a union's will do, and the flexible and scope-injected sources are never judged. The editor offers a union field the same set: its source menu lists every source any of the field's types offers (`getAllowedPropertySources` on the whole `type`; the first type still picks the editor control), and a Field dropdown lists every choice one of them takes — `$alarmCount`, `$viewport` width and `$page` depth all appear on a `['float', 'integer']` field.

---

## Datasource variables in depth (`$var`)

A datasource isn't a flat list — variables live in a tree. `$var` can point at four kinds of node:

| Node | What it is | Resolves to |
|---|---|---|
| **Scalar** | A single value | `String` / `Integer` / `Float` / `Boolean` / `DateTime` / `Date` / `Time` / `Duration` / `color` |
| **Array** | A scalar repeated N times | an array, or one element |
| **Struct** | A group of named members (a folder with variables inside) | an object `{ member: value, … }` |
| **Struct array** | A struct repeated N times | an array of objects, or one element |
| **Folder** | Pure organization (only folders inside) | nothing — not bindable |

The `$var` shape stays the same in every case:

```
{ $var: { path, index?, repeatIndex?, bit? } }
```

- `path` — `datasource:location`, where the location is slash-separated (`PLC:Motor/Speed`). The datasource name before the `:` identifies which connection (and whether it's OPC-UA or static).
- `index` — optional array position. Present only when you pick one element of an array.
- `repeatIndex` — optional; `true` takes the position from the surrounding Repeater copy instead (see [Repeater items in depth](#repeater-items-in-depth-repeatitem)).

### How each kind looks

```jsonc
// Scalar — a single tag
{ "$var": { "path": "PLC:Motor/Speed" } }

// Array — whole array
{ "$var": { "path": "PLC:Readings" } }
// Array — one element (index selects it)
{ "$var": { "path": "PLC:Readings", "index": 0 } }

// Struct — the whole object { Speed, Torque }
{ "$var": { "path": "PLC:Motor" } }
// Struct member — just point at the leaf, like any scalar
{ "$var": { "path": "PLC:Motor/Speed" } }

// Struct array — the whole array of objects
{ "$var": { "path": "PLC:Alarms" } }
// Struct array — one struct element
{ "$var": { "path": "PLC:Alarms", "index": 0 } }
```

Notes:

- **A struct member is just a scalar** — you reach it by its full `path` (`PLC:Motor/Speed`), not by binding the parent struct and digging in.
- **`index` is the only difference** between "the whole array" and "one element" — same `path`, with or without `index`.
- **Folders that contain only other folders carry no value** and aren't selectable. A folder *becomes* a struct as soon as it has variables directly inside it.

### Array fields

The mirror of an array `$var` is an **array field** — a field that wants many values instead of one. Any base type can be an array.

- A field declares it wants an array (e.g. a `string[]`). It may be **fixed-arity** (exactly N) or **variable-arity** (any length).
- A scalar source bound to an array field contributes a single element; an array source (`$var` with no `index`, `$languages`, `$user.groups`) fills the whole array.
- **Out-of-range `index`** resolves to *absent* (see below), not an error — the same fallback rules apply. The backend still reports a stored `index` that can name no element as `var-index`: one that is not a whole number or is negative, one on a variable that is not an array, and one at or past an array's fixed `length`. A `repeatIndex` binding is not judged on its `index`, which the Repeater copy replaces.

### Which variable fits a field

The binding picker, the runtime overlay and the backend's `var-type` /
`repeatitem-type` / `var-readonly` diagnostics decide it with one predicate — `accepts` in
`frontend/src/shared/types/varType.ts`, ported to
`backend/core/validation/vartype.py` and held equal by the shared fixtures in
`frontend/src/shared/types/__fixtures__/` (`varTypeAccepts.json`,
`structSatisfies.json`, `editorKindAccepts.json`, `itemListAccepts.json`,
`listItemTypes.json`).

- **Array-ness is exact.** An array field takes an array variable; a scalar field takes a scalar variable or one element of an array (`index`).
- **The base type is exact.** A `Float` field takes no `Integer` variable and an `Integer` field no `Float`; a field that takes both lists both (`['float', 'integer']`).
- **`color`, `icon`, `image` and `video` bind to a `String` variable** — the value is a CSS colour, an icon name or an asset path. A field that lists simple types beside the kind (`['image', 'string[]']`) binds to those instead. Kinds match case-insensitively, so a schema written in code as `'Color'` is still the colour kind. `option-list` binds to the arrays it lists and `item-list` to any array; `actions`, `widgets` and the other editor kinds bind no variable at all.
- **A struct is checked member by member** (`structSatisfies`). Every `requiredFields` entry must exist — a disabled variable, or one gone from the server, is no member, since the pool serves neither; one with nested `requiredFields` must be a struct itself and satisfy them; one with a `type` must hold a variable that type accepts as a field's `type` (an editor kind such as `color` meaning `String`); one with `write: true` must be writable. A struct array is judged on one element: the bound one when `index` names an element that exists, otherwise the lowest-index element there is (arrays may count from 1). A member whose type only the runtime knows is taken on trust for its type, never for its access. A struct whose metadata lists no fields yet (an empty struct array) is accepted.
- **A writing field needs a writable variable.** A field with `write: true` — or a required member with it — refuses a variable whose own `writable` flag is off. The variable metadata carries that flag (`false` when a variable never set it), and only `true` fills a writing field: a variable or member whose access is not stated is read-only, in the picker, the runtime overlay and the backend alike. A variable the registry has no entry for is not judged at all. A struct has no access of its own — its required members are judged instead. A Repeat item's index, and the element of a Repeater over anything but a variable, are never writable. The backend reports a broken access rule as `var-readonly`, naming the member for a struct, apart from a wrong type (`var-type` / `repeatitem-type`). Those are build diagnostics, which never block a save; the write itself is refused at write time — `write_service` answers `read_only` for any variable whose own flag is not `true` (see [websocket.md](websocket.md#action-result-correlation)).

The picker's tree filter, its ✓/✗ drawer, the runtime overlay and the backend
validator all run these checks, each with the members it has to hand — the
picker the datasource tree (or, for a Repeat item, the members the variable
metadata lists for the element), the runtime the variable metadata, the
backend its registry (the live pool's metadata, or the datasource files before
any pool has started, read the same way). So a variable the picker offers
without **Show all** is one the runtime and the warnings pill accept.

**A ✗ cannot be confirmed.** Whatever the drawer marks ✗ keeps Confirm
disabled, and double-clicking a row is held to the same verdict; Enter in the
search box takes the first result the field accepts. Every way of picking, a
Repeat item row included, goes through one check in
`VariableBindingPicker/index.tsx` (`isConfirmable`; `WidgetPropPicker` does the
same). **Show all** lists everything to browse except disabled variables: no list
shows those, since the pool serves them no value. A binding made before its
variable was disabled opens marked ✗ with *Disabled in its datasource*. A selection whose
datasource has not loaded yet has no verdict and stays confirmable. For a
writing field the tree lists only a variable whose `writable` flag is `true` —
one that states no access is read-only there, as the drawer and the backend
read it.

**A slot inside a source takes its own type, not the property's.** The
property's type, `write` and `requiredFields` describe the value the source
produces, not its operands, so each nested slot opens the picker with a type of
its own — the `slot` argument of `OpenBindingPicker`
(`PropertySourceEditor/editors/utils.ts`, `SlotType`), which every opener
honours in place of the property's filter while keeping its label. The
innermost slot that names one wins. The same slot reaches everything edited
inside it through `SlotContext` (`PropertySourceEditor/slotContext.ts`): a
source's `field` choices, and the `$componentProp` / `$widgetProp` pickers,
which then judge by the slot's type alone (any type, or that type read-only)
instead of the placeholder schema the slot's editor is drawn with. So an `$if`
nested inside a `$compare` operand has branches that take any type, like the
operand.

| Slot | Picker lists |
|---|---|
| `$if` condition, `$not` value, `$and` / `$or` item, action `if` condition | `Boolean`, read-only — no truthiness of another type; test an `Integer` or `String` through `$compare` (`BOOLEAN_SLOT`) |
| `$compare` left / right, `$switch` value and case `when` | Any type — ordering coerces with `toNumber`, `===` / `!==` use `looseEquals` |
| `$formula` operand | `Float`, `Integer`, `Byte` and `Boolean`, read-only — each operand is coerced to a number, a Boolean to 1 / 0 (`FORMULA_OPERAND_SLOT`); the **Bits** box is offered here |
| `$stringExpr` / `$http` wildcard | Any type — it is formatted into text |
| `$if` true / false, `$switch` then / default | What the property takes |

A nested operand with a type of its own (a `$compare`'s, a `$formula`'s)
replaces the condition's `Boolean`.

**Component and exported properties fit by the same rule.** The
`$componentProp` picker (`componentPropHelpers.ts`: `componentPropFits`,
`structSchemaNodeFits`) and the `$widgetProp` picker, which adapts each export
into the same shape, judge a property as a variable of its type would be
judged: the property is read in its schema-field form (a `select` as the type
its options hold), then `accepts` runs over the field's `acceptedValueTypes`
with the field's `write` flag — so an `Integer` property fits a read-only
`Float` field and a `String` property fits an `icon` field. A writing field
also needs the property to say it can be written — a component property's own
`write: true`, a struct row's `write: true` on a variable row; an export never
does — and the drawer shows ✗ with *Not declared writable* rather than hiding a
property of the right type. A struct property is
then checked with `structSatisfies` over its `structSchema`: a variable row is
its `type`, writable only with `write: true`; a folder row is a struct; an array
row is an array of its `type` (and the `requiredFields` a component derives from
its own schema say so, `Float[]`). A property of an editor kind (`icon`,
`color`, `actions`) holds that kind's own value, so it fits only a field of that
kind. An export that declares no type is a `String`.

The backend judges a stored `$componentProp` / `$widgetProp` by the same rule
(`backend/core/validation/component_property.py`, held to the TS by
`componentPropFits.json` and `componentPropertySchemaField.json`). A
`$componentProp` where no inputs reach — the shell, say, or a navigable page
without page variables — is `componentprop-no-scope` (a warning). Elsewhere it
is read against the declarations of the scope it sits in — a component
definition's own, a Dialogs-folder page's merged with its enclosing groups', or
a navigable page's Value inputs merged with its groups' (innermost first, see
[below](#pages-and-page-groups-declare-the-same-inputs)); a `a/b/c` path
resolves through the declaration's `structSchema`. A name the scope does not
declare is `componentprop-unknown` (a warning); one that does not fit, or does
not say it can be written into a writing field, is `componentprop-type`. A
`$widgetProp` names a widget of the same artifact, else one elsewhere in the
project (a Repeater copy's `<id>@<copy>` is the template widget). Ids are unique
within one tree only, so elsewhere several widgets can share one; any of them
reading fine is enough. A widget that exists nowhere, or an export none of the
candidates declares, is `widgetprop-unknown`,
and an export that does not fit is `widgetprop-type` (`path` into a `Struct`
export reads the field its `structSchema` declares). Built-in widgets' exports
come from the editor half of the baked manifest, and win over a custom row of
the same name — a `widget-schemas.json` left in the runtime home can still hold
one for a widget that has since become a built-in; custom widgets' come from
`widget-schemas.json`. A widget whose exports are not known is not judged.

A component instance's children are its slot content, and they render inside
the instance — `ComponentRenderer` provides the instance's `InputScopeContext`,
and `ComponentSlot` renders the caller's widgets under it without providing the
caller's back. So a `$componentProp` in slot content reads the *component's*
inputs, as the instance fills them, and the validator types it against the
component's declarations — even on a page that has no inputs of its own.

### OPC-UA datatypes & the datasources manager

The types above are the vocabulary the **HMI** speaks. A datasource doesn't store them directly: every variable in the **datasources manager** carries its **real OPC-UA datatype** (`Boolean`, `Int16`, `Int32`, `UInt64`, `Float`, `Double`, `String`, `DateTime`, …). Those real types live only in the OPC layer — the datasource config, the write path, and the simulated server. At the HMI boundary each one is collapsed to a value type, so a field never sees `Int16` or `UInt64`, only `Integer`.

The map is `OPCUA_TO_SIMPLE` in `backend/core/value_types.py`, mirrored in
`frontend/src/shared/utils/valueTypes.ts`. Lookup is case-insensitive.

| OPC-UA datatype | Simple type |
|---|---|
| `Boolean`, `Bool` | `Boolean` |
| `SByte`, `Int8`/`16`/`32`/`64`, `UInt16`/`32`/`64`, `Enumeration` | `Integer` |
| `Byte`, `UInt8` | `Byte` |
| `Float`, `Single`, `Double`, `Decimal` | `Float` |
| `String`, `ByteString`, `Guid`, `NodeId` | `String` |
| `DateTime` | `DateTime` |
| `Date` | `Date` |
| `Time` | `Time` |
| `Duration`, `TimeSpan` | `Duration` |
| *anything else* | `String` (fallback) |

- **The datasources manager is where the tree lives.** Browsing or editing a datasource records, per leaf, its real `data_type`, whether it's `writable`, and an explicit `is_array` plus optional positive `array_length` for fixed arrays. Folders organise, folders-with-variables become structs, and the same scalar / array / struct / struct-array shapes described above are exactly what `$var` binds to.
- **There are nine simple types.** `VALUE_TYPES` is `Boolean`, `Integer`, `Byte`, `Float`, `String`, `DateTime`, `Date`, `Time`, `Duration` — `Date`, `Time` and `Duration` collapse from their own OPC-UA datatypes rather than riding on `DateTime`. `color`, `icon`, `image` and `video` are the exception: they have no OPC-UA datatype at all and exist only as field types, refined by the **field**, never by the variable. A variable drives one as a `String`.
- **Live values arrive in JSON forms.** The collapse above is about types; the values themselves are normalized where they enter (`opcua.values.normalize_value` for OPC-UA): a `DateTime` arrives as ISO 8601 UTC with milliseconds (`"2026-01-02T03:04:05.678Z"`), an `Integer` beyond ±9,007,199,254,740,991 as its decimal string, a `LocalizedText` as its text. The full list is [Value forms](websocket.md#value-forms).
- **The static datasource works in reverse.** It has no live server, so picking a simple type synthesises a *representative* OPC-UA type to store (`SIMPLE_TO_REPRESENTATIVE`): `Integer` → `Int32`, `Byte` → `Byte`, `Float` → `Double`, `Boolean` → `Boolean`, `String` → `String`, `DateTime` / `Date` / `Time` → `DateTime`, `Duration` → `Double`. The round trip is therefore lossy for `Date`, `Time` and `Duration` — a static `Date` reads back as `DateTime`.

---

## Resolution & quality

A source doesn't always produce a clean value. Three things can go wrong, and each has a defined outcome:

| Situation | What it means | Resolves to |
|---|---|---|
| **Absent** | The source can't produce a value yet (no `index` match, a struct member that is not there at runtime such as a disabled leaf, page param missing with no `default`) | `undefined` — the field uses its own fallback / placeholder |
| **Bad quality** | A `$var` is connected but the server reports the tag as bad/uncertain/stale | the field renders its **quality-degraded** state (typically blank or dimmed); the last good value is *not* silently reused unless the field opts in |
| **Disconnected** | The datasource itself is down | treated as bad quality for every `$var` it owns |

**Coercion.** A source's base type should match the field's base type. When they differ, the widget's read (`getPropString` / `getPropNumber` / `getPropBoolean` in `frontend/src/hmi/components/layoutUtils.ts`, and their `useProp*` hooks) decides:

- A **number read** takes a number as-is, and a string only when it is a clean decimal number — `"42"`, `" -1.5 "`, `"2e3"`, the same grammar the OPC-UA write path accepts. Anything else (`""`, `"12px"`, `"0x10"`, `"Infinity"`, a boolean) is *absent* and the field falls back. Nothing is rounded: an `Integer` field that reads `2.5` gets `2.5`. `Integer` → `Float` is exact.
- A **string read** turns a number into the operator's text — a decimal comma through `formatNumber`, `3.5` → `"3,5"` — and a boolean into its plain text (`"true"`); formatting such as fixed decimals is the widget's own. A value matched against other values or written back (a Dropdown's, Button Row's or Data Grid's selection, a Data Grid filter, a String Input's text) reads `usePropVar` and keeps the point. Text a machine reads — an image, video or web frame URL, a Write Data Variable value, an `$http` request — is evaluated with `machineText` on the evaluation context: a number read as text, or filled into a `$stringExpr` placeholder at any depth, keeps its point.
- A **boolean read** takes a boolean as-is and a number as non-zero = `true`. A string is trimmed and lower-cased: `true` / `yes` / `on` / `1` read `true`, `false` / `no` / `off` / `0` read `false`, and `""` reads `true`. Any other value — another non-empty string, an object — is truthy (`Boolean(value)`); only an absent value takes the fallback.
- `usePropVar` returns the raw value and coerces nothing.
- A *variable* binding is stricter than any of this: no pair of base types crosses — see [Which variable fits a field](#which-variable-fits-a-field). The binding picker will not confirm a variable that does not fit; one that reaches a page anyway (a hand-edited file, a variable whose type changed) gets a `var-type` diagnostic from the backend and the red overlay at runtime. The overlay types a whole-value `$var` and the `$var` a `$if` / `$switch` result lands on — the branch on screen, picked as the render picks it. Every other variable on screen — a condition, a template or formula wildcard, anything inside a taken result that is not a plain `$var` — is checked for presence only; a losing branch is not judged at all.

Rule of thumb: **the editor prevents impossible bindings; the runtime turns the still-possible failures (absent / bad quality) into the field's fallback, never a crash.**

---

## HTTP requests in depth (`$http`)

`$http` binds a field to a value returned by an HTTP endpoint — a REST service
on the plant network, a weather API, an MES lookup.

```jsonc
{
  "$http": {
    "url": "https://mes.local/api/orders/{1}",
    "wildcards": { "1": { "$var": { "path": "PLC:OrderId" } } },
    "method": "GET",
    "headers": [{ "name": "Authorization", "value": "Bearer {2}" }],
    "body": "",
    "path": "order/quantity",
    "refreshSeconds": 30
  }
}
```

- **`url`, `body` and every header `value` are templates.** They use the exact
  same `{1}` / `{Trim(ToLower(2))}` placeholder syntax and function set as
  `$stringExpr`, filled from the shared `wildcards` bag. A wildcard is itself a
  full property value, so a `$var` in the url means the request re-targets as
  the variable changes.
- **`headers` has no editor.** The runtime and the proxy honour it, so a request
  written by hand (or through MCP) can carry auth headers, but the property
  panel only edits url / method / body / path / refresh.
- **`path` picks one value out of the response.** It is the slash-path syntax
  used elsewhere (`data/0/value`); numeric segments index arrays. Empty means
  the whole body. A path that misses resolves to *absent*, like any other
  source that can't produce a value.
- **The produced type is whatever the endpoint returned.** Scalars pass through
  as `String` / `Integer` / `Float` / `Boolean`; an object or array pick is
  surfaced as JSON text (the same convention `$result` uses).
- **`refreshSeconds`** polls the endpoint. `0` (or absent) fetches once and
  serves the cached response for the rest of the session.

### How it resolves

Property evaluation is synchronous and HTTP is not, so `$http` never fetches
inline. The evaluator hands the fully templated request to a response cache
(`frontend/src/hmi/store/httpSourceStore.ts`) and returns whatever is cached
right now — `null` on the very first read. Widgets holding an `$http` source
subscribe through `useHttpTick`, so the value appears on the next render and
again on every refresh. Requests are keyed by resolved url + method + headers +
body, so two widgets reading different fields of one endpoint share a single
request, while a changed `{1}` is simply a different key.

Requests go out through the backend proxy `POST /api/http-request`
(`backend/api/http_source_api.py`) rather than from the browser: a plant REST
service will not have CORS headers for the HMI's origin. The proxy allows
`http`/`https` only, times out at 10s, caps the response at 1 MB, and reports
failures inside a 200 body (`ok: false`) so an unreachable endpoint reads as a
normal absent value rather than a broken API call.

> The proxy is not general. It performs a request only when its **origin**
> (scheme + host + port) is one an `$http` source somewhere in this project
> names — path, query, headers and body stay free, since the author's templates
> fill those in. The allowlist is derived from `config.json`, the page files, the
> components, `alarms.json` and `recipes.json` (`backend/core/http_origins.py` —
> every document whose property values are validated) and re-derived whenever they
> change, so it can only be widened by editing the project. Redirects are walked
> one hop at a time with the same check on each.
>
> Only a placeholder in the *scheme, host or port* of an absolute template
> (`http://{1}/x`, `{1}://h/x`, `http://h:{1}/x`) names no fixed origin. Such a
> *dynamic-host* template reaches only the origins the project lists by hand in
> `config.json` under `httpAllowedOrigins` (edited in the editor's **Admin ›
> HTTP sources**, `GET`/`PUT /api/config/http-origins`). The list applies to every
> request, because a resolved request carries nothing that ties it back to the
> source that rendered it, and it is compared exactly like a derived origin. While
> it is empty a dynamic-host request is refused, and validation reports
> `http-dynamic-host-unlisted` on the template so the editor's warnings pill says
> so first. A rendered host is a value an operator or PLC can steer and the proxy
> is anonymous, so it never follows one to an origin nobody named.
>
> A listed origin never names this machine: loopback, link-local and unspecified
> addresses, `localhost` and the numeric spellings of 127.0.0.1 are refused by the
> write endpoint and ignored if hand-edited in. A local service is still
> reachable through a literal template (`http://localhost:9000/api`), where the
> target is visible in the source that uses it.
>
> A relative template (`/api/status/{id}`) is not a dynamic-host template — it
> contributes no origin and needs no list entry — and a placeholder in the path,
> query or credentials (`https://{user}:{pass}@h/x`, which still pins
> `https://h:443`) is irrelevant.

---

## Repeater items in depth (`$repeatItem`)

A **Repeater** draws its child widgets once per element of an array, its
`item-list` property **Items**. Each copy publishes a *repeat scope* — the
element, its index, and where the array came from — and the widgets inside read
it:

```jsonc
{ "$repeatItem": { "field": "value" } }                     // the element
{ "$repeatItem": { "field": "value", "member": "Speed" } }  // one member of it
{ "$repeatItem": { "field": "index" } }                     // its 0-based index
{ "$var": { "path": "PLC:Names", "repeatIndex": true } }    // a parallel array, same index
```

The editor writes `repeatIndex` from the variable picker's `[#] this copy` row
under an array (offered when the slot passes `repeatIndex`), or when a path is
typed with a `[#]` suffix (`PLC:Names[#]`), next to the `[n]` suffix that sets
a fixed `index`. `$repeatItem` and the write/toggle `repeatItem` target come
from the picker's separate Repeat item mode (`repeatItem` option;
`VariableBindingPicker/repeatItemRows.ts`), which lists only the copy's element
and never the datasources — see `PickerExtras` in
`frontend/src/config/store/domains/editorDomainStore.ts`. The validator types a `$repeatItem`
against its field when the Repeater repeats over a known variable, or over a
list whose values say what an element is (`repeatitem-type`), and the picker
filters and marks the pick by the same types.

- **A variable element stays a variable.** When Items is a `$var` array, a
  `$repeatItem` is rewritten into the `$var` it stands for before the widget sees
  it — `{ path, index }` for a scalar-array element or a whole struct element, the
  member's own leaf (`PLC:Motors/[2]/Speed`) for a struct member. The live
  subscription, the binding overlay and the widget's own writer then treat it as
  any other binding, so an input inside a Repeater writes back to its element.
  The leaf path comes from the element folder's real name in the variable
  metadata, since a static server may call it `Line[2]` rather than `[2]`.
- **Any other source is read-only.** Over `$static`, `$http` (a JSON-array
  pick), `$recipeList`, `$user` users/groups or `$widgetProp`, `$repeatItem`
  resolves to the element's value; `member` is a slash-path into it, and a record
  surfaces as JSON text. A literal or `$static` list is typed by its values
  (`listItemTypes`): records make a struct of every key any record has, a member
  typed when all its values share one simple type (a string `String`, a boolean
  `Boolean`, a whole number `Integer`, a fractional one `Float`; whole and
  fractional numbers together `Float`), and a list of scalars the same way.
  Mixed values, values that are objects or arrays, and records with no keys at
  all are not typed and are taken on trust. An empty list offers
  `{ label, value }` with no member types; a `$user` list is `{ label, value }`
  strings. Over `$http`, `$recipeList` and `$widgetProp` only the runtime knows
  the element, so its type is trusted — but, like every non-variable element, it
  never fills a writing field (`var-readonly`) or a write/toggle target
  (`write-target-type`).
- **Only the innermost Repeater is reachable.** A nested Repeater shadows the
  outer one's item.
- **Write and toggle actions can target the item.** A `writeDataVariable` /
  `toggleDataVariable` names its variable as a sourced `target`: a `$var`, or
  `{ $repeatItem: { member? } }`, which becomes the copy's `$var` like any other
  `$repeatItem` does — and is skipped when the element is read-only, since no
  `$var` comes out.
- **`$widgetProp` is per copy.** Every copy shares its template's widget ids, so
  an export is kept per copy and a sibling inside the Repeater reads the one
  beside it. A reader outside the Repeater gets the first copy's.
- **The editor draws the template, then ghosts.** On the canvas the first copy is
  the editable template; the rest are dimmed and select the template when
  clicked. With no elements at all the template is still drawn once.
- **An action list can repeat over its own widget's items.** A schema field of
  type `actions` that declares `repeatsOver: '<item-list prop>'` runs with one
  element of that list — Data Grid's **On Select** with the picked row. The
  editor offers Repeat item inside it and the validator types it against that
  list, as if a Repeater enclosed it; at run time the widget passes
  `repeatIndex` and `resolveRepeatItem` on the `evalCtx` it hands
  `executeWidgetActions`, which reads the element's value (read-only).
- **Outside a Repeater** `$repeatItem` resolves to *absent* and a `repeatIndex`
  binding reads the whole array. The warnings pill flags both
  (`repeatitem-no-scope`), except inside a component definition, whose
  instances may be placed in one.

---

## Component inputs in depth (`$componentProp`)

A component can declare **input properties** — values the parent fills in when placing it. Inside the component, children read those values with `$componentProp`:

```jsonc
{ "$componentProp": "motorVar" }
```

Each input has a **type**, exactly like any other field. So an input can be a `String`, `Integer`, `Float`, … or a **struct** (an object with named members). It may also carry a `description` (one line shown under the field) and a `defaultValue`.

The value an instance puts in an input is checked against that type the way a widget's property is against its schema: the backend reads each declaration as its schema field (`componentPropertyToSchemaField`, ported as `component_property.to_schema_field`) and runs the literal, `var-type`, `var-readonly` and `source-type` checks on it. A mismatched literal there is a `literal-type` diagnostic, not a rejected save. A component whose declarations were not read is not typed.

An `option-list` input passes a whole `{ label, value }[]` list — a static array, a bound array or any other source an `option-list` field takes — and fits an `option-list` field, so a component's Dropdown or Button Row reads `options: { "$componentProp": "options" }`. Both widgets read their options through `useOptionListProp`, which evaluates every label with the eval context, so a `{ "$loc": … }` label shows translated.

One declared type is not an input at all: `widgets` names a [slot](data-formats.md#component-slots). It holds no value, so `$componentProp` cannot read it and the binding picker never offers it; what it declares is where the *caller's widgets* go.

### Value or Binding

Every input of a component, page or page group with a valued type has a `mode` (`inputMode` in `frontend/src/shared/types/componentProperty.ts`, ported as `component_property.input_mode`):

| | `value` | `binding` |
|---|---|---|
| The opener or instance passes | anything: a literal, `$loc`, a formula, a variable | a `$var`, or a `$componentProp` / `$repeatItem` standing in for one — never a computed source, never a Value input passed on |
| Read | once — when the dialog opens, or when the instance appears | live |
| Written by Write, Toggle, Edit Value or a writing widget | the local copy, in this screen or instance only | the variable, so the OPC-UA server |
| Back to the opener | never | through the variable |
| Lives | until the dialog closes, the page or group leaves the view, or the instance unmounts; opening again reads again | as long as the variable |

A struct is always a Binding (it is a variable folder), and `actions`, `widgets`, `icon`, `image`, `video` and `option-list` (the editor's **Options**) have no mode — they pass through as given. A declaration without `mode` is a Value unless it declares `write`, which only a Binding uses; format 12 writes the mode out on every existing declaration (`core/migration_input_modes.py`). A Value ignores `write` (`componentPropertyToSchemaField` drops it), so a `$componentProp` naming a Value fits any writing field; a Binding's schema field carries `bindsOnly`, which limits its editor row to a variable, as `write` does.

**Where the local copy lives.** A Value is a slot of the variable store under the reserved datasource `$input` (`LOCAL_INPUT_DATASOURCE`, `frontend/src/hmi/store/variableStore.ts`), keyed by a per-mount frame id: `useValueInputs` (`frontend/src/hmi/hooks/useValueInputs.tsx`) seeds the slots and the input scope hands readers a plain `{ "$var": { "path": "$input:<frame>/<slot>" } }`. Reading, `extractVarKeys` subscriptions, `$compare` and every writer therefore treat a Value as a variable, and nothing else has to know about it: `sendWsMessage` applies a `write_field` / `toggle_field` aimed at `$input` to the store instead of sending it (answering a tracked request itself), the binding-status overlay skips `$input` keys, and the store keeps them across a reconnect, a snapshot and a metadata frame. The backend never sees one.

**When it is read.** `openDialog` evaluates the values it passes to a Value input of the target node in the opener's own context (`executeWidgetActions`), so the overlay receives literals. `ComponentRenderer` seeds its Value inputs from what the instance passes (its own surroundings' context) and `PageGroupPageView` one slot per declaring node and name of its trail — a page's and its group's never share one, and a group's survive moving between its pages. A seed that reads a variable whose value has not arrived waits for it, so an instance mounted with its page does not latch the empty store; a changed *source* (an author editing the instance) is read again, a changed *value* of the same source is not. Page and group `events` and `$overlay` read the values the overlay was opened with, not the local copy.

### Pages and page groups declare the same inputs

Components are not the only thing that takes inputs. A page and a page group each carry a `componentProperties` map of the identical shape, and the widgets inside read it with `$componentProp` exactly as a component's children do — no separate source exists for them. What differs is who fills the values in: not a placement, but the action that opens the overlay. `openDialog` takes a `componentProperties` map, resolved against the opening widget's own scope before it is handed over. Only a node in the **Dialogs** root declares inputs — a navigable page has no action to fill them, which is why the sibling `openPageOverlay` carries no such map (see [data-formats.md](data-formats.md#config-file-v2--split-page-storage)). `openDialog` may name a page *or* a page group; a group opens its active child inside the group's header/footer chrome, which is what makes a parameterised tabbed modal one overlay rather than several.

A page reached by ordinary navigation — a menu, a Tab Bar, a URL — is opened by no action, so nothing is handed in: `HmiView` renders the routed page through `PageGroupPageView` *without* `takesInputs`. Only its Value inputs count there — the **page variables**, each starting at its `defaultValue` when the page (or group) enters the view; any other declaration is skipped and a `$componentProp` naming it reads nothing. Navigation targets and URL parameters deliberately carry none. Values supplied to a page overlay belong to that overlay instance, so navigating to a sibling page inside the open overlay keeps them. A Dialogs-folder node's own `events` (`onOpen` / `onClose`) run with the same values in scope, defaults filled in (`usePageEvents`), so an open event can write them to the machine — a Write Data Variable `value` may be a `$componentProp`.

### Defaults

`defaultValue` applies at runtime, not only in the editor: an instance that leaves a property `undefined` gets the declared default before the component's tree renders, so what the properties panel shows as the field's `· default` hint is what `$componentProp` resolves to. An explicit `null` is a *set* value — an author clearing a field on purpose — and does not fall back. Pages and page groups fill their declarations in the same way (`withDeclaredDefaults`, one helper for all of them) — but only where `PageGroupPageView` is given `takesInputs`, which is a Dialogs-folder overlay and nothing else; elsewhere only a Value input's default is read, as its starting value. A parameterised page is therefore not usable as a navigation destination: it lives in the Dialogs root, which nothing navigates to, and `_check_navigable` in `backend/core/validation/structure.py` reports a menu item or `format: 'page'` field naming one as an error. Struct, `actions` and `widgets` properties have no default (a struct resolves to a variable subtree, an actions list to handlers, a `widgets` property to whatever the caller puts in the slot).

A name can be declared at several levels at once — on the page and on the groups it nests in. **The innermost declaration wins**: a widget on the page sees the page's default, a widget in a group's chrome sees that group's, and an outer group's is reached only when nothing inner declares the name. Values the opening action supplied sit above every default. `PageGroupPageView` computes this by folding the declaration chain innermost-first (`foldInputScope`): a Value input takes its local slot unless an inner node declares the name, anything else is filled through `withDeclaredDefaults`, which only fills a key that is still `undefined`; the shadowing is deliberate and raises no diagnostic. Chrome is *outside* the page, so a group's header and footer never see the active page's declarations.

### `$componentProp` substitution

`resolveComponentPropValue` (`frontend/src/hmi/utils/componentPropResolution.ts`) rewrites every `{ "$componentProp": "<key>" }` in a value, at any depth, into what the scope holds for that key, before evaluation. `useResolvedProperties` runs it over a widget's properties and `useResolvedLayout` over its layout, so a forwarded `$var` nested in `$if` / `$compare` / `$not` / `$stringExpr` / `$switch` is an ordinary `$var` by the time `extractVarKeys` collects the live subscription. A `key/member/path` appends the member path to the forwarded `$var`'s `path`. A widget node kept in a property (a slot's content) is skipped — it resolves its own — and a key the scope does not hold stays a reference, which the evaluator reads as no value.

### Struct inputs

A struct input declares its members up front, as a `structSchema` tree. Each node is a `variable` (one leaf of a simple `type`), an `array` (a list of that `type`) or a `folder` (a nested struct, with its own `children`); `write: true` on a leaf asks for write access:

```jsonc
// in the component's input definition
{
  "sensor": {
    "type": "struct",
    "label": "Sensor",
    "structSchema": [
      { "kind": "variable", "name": "bEnabled", "type": "boolean" },
      { "kind": "variable", "name": "fValue",   "type": "float", "write": true },
      { "kind": "array",    "name": "aHistory", "type": "float" },
      { "kind": "folder",   "name": "stFiltered", "children": [
        { "kind": "variable", "name": "bValue", "type": "boolean" }
      ] }
    ]
  }
}
```

- **Every declared member is required.** There is no optional flag. The tree becomes the field's `requiredFields` (`componentPropertyToSchemaField`), and a struct variable fits only when it carries every member with a fitting type, and write access where a leaf asks for it — the binding picker, the backend's `var-type` diagnostic and the runtime overlay all apply that rule.
- **Extra members are fine.** A variable may carry more than the tree declares; a child can still read those by slash-path.

### Reading a struct input

A child can bind the **whole struct**, or drill into **one member** by slash-path:

```jsonc
// the whole object { bEnabled, fValue, aHistory, stFiltered }
{ "$componentProp": "sensor" }

// a single member
{ "$componentProp": "sensor/fValue" }

// a nested member
{ "$componentProp": "sensor/stFiltered/bValue" }
```

### What happens to a missing member

There's no "default value" mechanism for struct members. Required means the binding is *judged* against the tree, not that the value is guaranteed: a member that is not there at runtime — its leaf disabled in the datasource, a value not yet arrived, a hand-edited binding the diagnostics flag — is simply **absent**, and a child that reads it gets nothing. So the component still decides the fallback:

```tsx
const enabled = fields?.bEnabled === true   // absent reads as false
const value = typeof fields?.fValue === 'number' ? fields.fValue : 0
```

Rule of thumb: **declare every member the component needs, and still guard every read.**

---

## Page metadata in depth (`$page`)

`$page` with an explicit `pageId` reads that page. **Without one it reads the
page being rendered** — not the route. `resolvePage` resolves
`pageId ?? hostPageId` (`useEvalContext`), and `hostPageId` comes from
`HostPageContext`, which the page's own content and a page-group's chrome bands
provide. Only where nothing provides it does it fall back to the route's active
page, derived from `location.pathname` and falling back in turn to the first
page on the index route.

On an ordinary screen the two are the same page, so the distinction never shows.
Inside a **page overlay** they are not: an overlay action renders a page without
touching the URL, so the route still names the host page while `$page` correctly
reports the overlay's. A gate keyed on the overlay's page

```json
{ "$switch": {
  "value": { "$page": { "field": "id" } },
  "cases": [ { "when": "wiz-2", "then": { "$compare": { … } } } ],
  "default": true } }
```

matches its case in an overlay exactly as it does on a route, and a step counter
built the same way renders the step it is on. A page-group's shared `header` /
`footer` band resolves the group's **deepest active child**, so one band can
distinguish its steps — a `$switch` on `$page.id` in the band of a wizard group
selects per step.

Three scopes still resolve the route's page, because no page owns them: the app
shell's header, footer and sidebars; and anything rendered outside
`HmiView`'s page tree. That is the right answer there — a breadcrumb in the app
header describes where the operator navigated to, not what an overlay happens to
be showing on top of it.

`$pageIsActive` reads the same `hostPageId` when no explicit `page` is given,
but answers a different question: it compares against the **route's** active
page. Inside an overlay it is therefore `false` — the overlay's page is rendered,
not navigated to. Its picker offers navigable pages only, for that reason: a
Dialogs-folder page could never make it true.

## Type diagnostics

What the backend reports when a stored value does not fit its field
(`backend/core/validation/structure.py`). All of them are build diagnostics:
they mark the row and the warnings pill and never block a save. Two writes
are rejected outright instead: a bare
literal of a type its field does not list when that field's first type is a
scalar, and an action naming a page that does not exist in a field the widget's
own schema (or the property name `actions`) marks as actions. Anything the validator cannot know (a datasource
with no typed variables yet, an interface it did not read, a widget's unknown
exports) is skipped, never guessed.

| Code | Severity | Reported when |
|---|---|---|
| `literal-type` | error | A literal fits none of its field's types. A bare scalar fits when it matches *any* scalar type of a union (`["string", "integer", "float"]`); an array fits an `X[]` the field lists when every element is an X; a `$static` payload is held to the same rule. A mismatch in an array, a `$static`, a component instance's value, an action's field or a field whose first type is an array is this code; a bare scalar anywhere else is still rejected |
| `literal-format` | warning | A string that only fits as a `Date`, `DateTime`, `Time` or `Duration` does not read as one: ISO 8601 (`2026-06-16`, `2026-06-16T14:30:00Z`, `14:30:00`, `PT1H30M`), or a number of seconds for a `Duration`. Empty is unset, not malformed |
| `source-type` | error | A fixed-type source its field's type does not offer, or a stored `field` choice that yields another type (see [Sources](#sources)) |
| `var-disabled` | warning | A `$var` or write target naming a variable its datasource holds, still present on the server, but has disabled — the registry leaves it out, so this replaces `var-unknown`. Typically a tag disabled after it was bound; enabling it in the datasource clears it |
| `write-source` | error | A field with `write: true` holding anything but a `$var`, `$componentProp` or `$repeatItem`: a literal, a `$static`, a `$formula`, an `$if` and every other computed source leave the control no variable to write to. The editor offers a writing field only a variable binding, as it does a struct field, and refuses such a paste |
| `value-reads-once` | warning | A Value input given a source that computes over a variable — a formula, a condition, a string expression with a `$var` or `$componentProp` inside — by an instance or an Open Dialog: it is read once, as the instance appears or the dialog opens. A bare variable is not flagged; it is the way to hand a Value its starting point |
| `binding-source` | error | A Binding input (see [Value or Binding](#value-or-binding)) given anything but a `$var`, `$componentProp` or `$repeatItem` — a literal, a formula, a condition — or given a `$componentProp` naming a Value input, whose local copy the receiver would then write |
| `var-index` | error | A bound `index` that names no element (see [Array fields](#array-fields)) |
| `var-type` / `repeatitem-type` / `var-readonly` | error | A `$var` or `$repeatItem` whose variable does not fit the field, or is not writable where the field writes (see [Which variable fits a field](#which-variable-fits-a-field)) |
| `componentprop-type` / `componentprop-unknown` | error / warning | See [Which variable fits a field](#which-variable-fits-a-field) |
| `widgetprop-type` / `widgetprop-unknown` | error | See [Which variable fits a field](#which-variable-fits-a-field) |
| `write-target-type` | error | A Write Data Variable or Toggle target the write path cannot write: a struct (a write addresses one variable — a whole array or one element of it — never a struct folder), a variable not known to be writable, or the Repeat item of a Repeater over a list rather than a variable |
| `toggle-target-type` | error | A Toggle target that is not a single Boolean — a toggle reads the current value and inverts it |
| `edit-target-type` | error | An Edit Value target that is not a single Integer or Float — the numpad enters one number |
| `numpad-position-invalid` | error | An Edit Value `position` other than `center` or `bottom-right` |
| `navigate-target-invalid` | error | A Navigate To Page `pageId` that is neither a page id nor a `$componentProp` |
| `navigate-input-not-page` | error | A Navigate To Page `$componentProp` naming an input parameter not declared here with `format: "page"`, or used where no input parameters exist |
| `runcomponentactions-invalid` | error | A Run Component Actions `property` that is missing or not a string — it holds the bare name of a property, never a binding |
| `runcomponentactions-no-scope` / `runcomponentactions-unknown` / `runcomponentactions-not-actions` | error | A Run Component Actions `property` used where no component passes one in (a navigable page, the shell, global events), naming no declared property, or naming one not declared as `actions` |
| `write-value-type` | error | A fixed Write Data Variable value (bare or `$static`) that `coerce_entry_write_value` in `backend/services/write_service.py` would reject against the target's entry — its OPC-UA type, array shape and fixed length, and `min` / `max` — worded as the editor's row words it (`writeCoercionMessages.json`). The entry is the live pool's when it serves the datasource, else the datasource file's |
| `value-invalid` | error | A malformed source payload inside an action's field (`{ "$loc": 5 }`) — rejected elsewhere, reported here |
| `alarm-value-not-var` | error | An entry of an alarm's `values` list that is not a `$var` binding — the backend can only store a variable's value when the alarm fires ([Alarm Files](data-formats.md#alarm-files)) |
| `repeat-placement` | warning | An element of a Repeater's typed-in Items, with **Place copies** at item x / y, whose `x` or `y` is not a number from 0 to 1, or whose `side` is not `top`, `bottom`, `left` or `right` |
| `action-page-unknown` | error | An action naming a page that does not exist, inside a component instance's property that only its declaration types as `actions`. The same action in a widget's `actions` field is a rejected write |

**Values inside actions are values.** Every field of every action type is
listed with what it is checked as in `ACTION_FIELDS`
(`structure.py`), mirroring the editors in
`PropertiesPanel/actionEditors.tsx`: toast, alert, login, language and theme
texts are `String`, overlay `width` / `height` and toast `duration` are
`Integer`, `verify`, `dismissible` and an `if` condition `Boolean`,
`openDialog`'s input values take the types the target page declares, and a
sourced Write Data Variable value takes the target's type. The same table
drives the walk: the fields it calls `actions` are the nested lists walked, and
those it calls `page` the page references checked. Each value is run through
the same checks as a property, so `var-unknown`, `loc-unknown`, `var-type`,
`source-type` and the `componentprop-*` codes apply inside actions too. A
Repeat-item target is judged on the element — or member — its Repeater's
`$var` items hold.

## Putting it together

To fill in any property:

1. Look at the field — that tells you the **type** it needs (and maybe a **format**).
2. Pick a **source**:
   - a **flexible** source (works anywhere), or
   - a **literal-typed** source whose type matches the field (for sources with an inner `field`, pick the `field` that yields the right type).

> Example — a label's `text` (type `String`):
> `$static` (type it in), `$var` (a string variable), `$loc` (translation), or `$stringExpr` (template) all work.
> `$alarmCount` would not — it produces an `Integer`.

---

## Related docs

- [data-formats.md](data-formats.md) — where property values are stored on disk (config, pages, widgets, alarms) and the datasource variable-tree format.
- [frontend.md](frontend.md) → *Property Types and Sources* — the editor (`PropertySourceSelector` / `PropertySourceEditor`) and runtime (`propertySourceEval.ts`) wiring.
- [../reference/custom-widgets.md](../reference/custom-widgets.md) — the schema `type` / `format` contract and the SDK hooks (`usePropString`, `usePropVar`, …) that resolve these sources.

Implementation entry points: `frontend/src/hmi/utils/propertySourceEval.ts` (runtime), `frontend/src/hmi/utils/propertySourceRegistry.ts` + `propertySourceRules.ts` (sources per type), `frontend/src/shared/utils/valueTypes.ts` / `backend/core/value_types.py` (OPC-UA collapse), `backend/core/validation/structure.py` (`PROPERTY_SOURCE_KEYS`, `ACTION_FIELDS`, the type diagnostics) with its ports `source_rules.py` (sources per type) and `component_property.py` (input declarations).
