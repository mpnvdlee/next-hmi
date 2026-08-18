# Property Value Types

Every property value answers two questions:

1. **What type is it?** — the kind of value (`String`, `Integer`, `Float`, `Boolean`, `DateTime`, `Date`, `Time`, `Duration`, `color`, `icon`, `image`). Any type can also be an **array** of that type.
2. **Where does it come from?** — the source (a literal you typed, a datasource variable, the logged-in user, a computed expression, …).

The **type is decided by the field**. A label's `text` field needs a `String`; a gauge's `value` field needs a `Float`. You don't pick the type — you pick a **source** that produces the type the field wants.

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
| `Float` | `3.14` | Continuous values, sizes, measurements |
| `Boolean` | `true` / `false` | Visibility, enabled, toggles |
| `DateTime` | `"2026-06-16T14:30:00Z"` | Timestamps, date + time values |
| `Date` | `"2026-06-16"` | Calendar dates (no time) |
| `Time` | `"14:30:00"` | Times of day (no date) |
| `Duration` | `"PT1H30M"`, `5400` | Spans of time, elapsed/remaining |
| `color` | `"#ff0000"`, `"var(--accent)"` | Colors, fills, strokes |
| `icon` | `{ type, name }` | Icon pickers |
| `image` | `{ path }` | Image from `assets/` |

### Formats (subtypes)

The types above are the *runtime* kinds. A field may also declare an **optional format** that refines a base type without changing it — it only drives editor affordances (which picker/validator to show). A field with no format just gets the default editor for its base type; a format only *upgrades* that editor. The set is **open-ended** — new formats are added when a value (already valid as its base type) deserves a richer picker:

| Base type | Format | Editor shows |
|---|---|---|
| `String` | `url` | A URL field with validation |
| `String` | `multiline` | A multi-line text area |
| `String` | `select` | A dropdown of allowed values |
| `String` | `password` | A masked input |
| `String` | `length` | A CSS size input (`300px`, `50%`, `auto`) |
| `String` | `spacing` | A box editor for 1–4 side values (`8px`, `8px 16px`) |
| `String` | `direction` | A `row` \| `column` picker |
| `String` | `align` | A cross-axis alignment picker (`start`, `center`, `end`, `stretch`, …) |
| `String` | `justify` | A main-axis alignment picker (`start`, `center`, `end`, `space-between`, …) |
| `String` | `page` | A dropdown of the project's pages (stores the page id) |
| `Float` | `percentage` | A 0–100 input with a `%` affix |
| `Boolean` | `toggle` | A plain on/off switch (default) |
| `Boolean` | `visibility` | A **Visible / Hidden** toggle |
| `Boolean` | `enablement` | An **Enabled / Disabled** toggle |
| `Boolean` | `wrap` | A **Wrap / No wrap** toggle |

A boolean format only relabels the two states (`true` shows as *Visible* / *Enabled* / *Wrap*, `false` as *Hidden* / *Disabled* / *No wrap*); the stored value is still `true` / `false`, and every boolean source still works unchanged.

A value's source rules are decided by its **base type** — format is purely a UI hint. `option-list` is just "an array of a base type" with a list editor; it is not a separate type.

---

## Sources

Two kinds of source, by where their type comes from:

- **Flexible** — carries whatever type the field needs (shown as `any`). Usable almost anywhere.
- **Fixed-type** — always produces one specific type. Only valid where the field wants that type. Some of these take an inner `field` selector; once it's pinned, the produced type is fixed (a source whose `field` choices span several types simply appears once per type below).

> **Source availability is decided by the field's *type* alone.** A source is offered wherever its produced type matches the field — there is no per-field allowlist. The old `valueSourceTypes` schema field (which let a widget hand-pick which sources its inputs accept) is **removed**: it duplicated and fought the type system. Drop `valueSourceTypes` from every schema; the field's `type` is the single gate for which sources appear.

### Flexible sources (fit any field)

These carry whatever type the field requires, so you can use them almost anywhere.

| Source | Shape | What it gives you |
|---|---|---|
| `$static` | `{ $static: value }` | A fixed value you type or pick — the literal for **any** type, including a structured `icon` (`{ type, name }`) or `image` (`{ path }`). For those, the editor opens a picker rather than a text box |
| `$var` | `{ $var: { path, index? } }` | A live datasource / OPC-UA variable |
| `$widgetProp` | `{ $widgetProp: { componentId, property, path? } }` | A property **exported by another component** on the page (sibling → me). `path` is an optional slash-path into a struct/array member of the exported value (e.g. `name` on a selected row) |
| `$componentProp` | `{ $componentProp: name }` | A value **passed in by my parent** component or dialog (parent → me) |
| `$result` | `{ $result: field }` | An action's result (only inside `onSuccess` / `onFailed` / `onSettled`) |
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
| `$random` | Float | `{ $random: { min, max, integer? } }` | A random number (`integer` when whole numbers wanted) |
| `$alarmCount` | Integer | `{ $alarmCount: { filter } }` | Count of `all` \| `unacked` \| `error` \| `warning` \| `info` alarms |
| `$recipe` | String / Boolean | `{ $recipe: { type, field } }` | Scoped to a dataset type: `activeName` (loaded recipe name), `loaded`, or `parametersChanged` (live values differ from the loaded dataset) |
| `$recipeList` | Record[] | `{ $recipeList: { type } }` | A dataset type's saved recipes as grid rows `{ id, name, description, lastLoaded }` (empty `type` = all types). Offered on `record-list` fields; read with `useRecordListProp` |
| `$compare` | Boolean | `{ $compare: { left, operator, right } }` | A comparison result (`>` `<` `>=` `<=` `===` `!==`). The ordering operators coerce both sides to numbers, treating a non-numeric side as `0`. `===` / `!==` are **not** strict despite the spelling: `looseEquals` compares identity first, then number-vs-string by `parseFloat`, so `5 === "5"` is `true` while `true === 1` is `false` |
| `$pageIsActive` | Boolean | `{ $pageIsActive: { page? } }` | `true` when the target page is active |
| `$languages` | String[] | `{ $languages: {} }` | The project's language list |
| `$user`, username | String | `{ $user: { field } }` `field: username` | The logged-in user's name |
| `$user`, groups | String | `{ $user: { field } }` `field: groups` | The logged-in user's group **labels, comma-joined** — `resolveUser` returns `groups.map(labelOf).join(', ')`, so this is one `String`, not a `String[]`, despite the registry advertising `string[]`. For membership tests use `$userGroups`, which is what the `visible` / `interactable` gate uses |
| `$user`, userList | Record[] / String | `{ $user: { field } }` `field: userList` | Every username in the project. Its home is an **`option-list`** field, where it resolves to `{ label, value }` pairs; bound to a scalar field instead it joins the names with `", "`, since `ResolvedValue` cannot carry an array |
| `$userGroups` | Boolean | `{ $userGroups: { groups } }` | `true` when the logged-in user is in one of the selected groups (empty `groups` = everyone). The source behind the standard `visible` / `interactable` group gate |
| `$page`, id | String | `{ $page: { field, pageId? } }` `field: id` | The page's id |
| `$page`, title | String | `{ $page: { field, pageId? } }` `field: title` | The page's title |
| `$page`, icon | String | `{ $page: { field, pageId? } }` `field: icon` | The page's icon name |
| `$page`, description | String | `{ $page: { field, pageId? } }` `field: description` | The page's description |
| `$page`, breadcrumbLabel | String | `{ $page: { field, pageId? } }` `field: breadcrumbLabel` | The page's breadcrumb label |
| `$page`, parentId | String | `{ $page: { field, pageId? } }` `field: parentId` | The id of the page's parent |
| `$page`, pathString | String | `{ $page: { field, pageId?, separator? } }` `field: pathString` | The breadcrumb trail joined by `separator` |
| `$page`, depth | Integer | `{ $page: { field, pageId? } }` `field: depth` | How deep the page sits in the page tree |
| `$page`, pathSegments | String[] | `{ $page: { field, pageId? } }` `field: pathSegments` | The breadcrumb trail to the page |
| `$viewport`, size | String | `{ $viewport: { field } }` `field: size` | The size class (`phone`/`tablet`/`laptop`) |
| `$viewport`, orientation | String | `{ $viewport: { field } }` `field: orientation` | `portrait` or `landscape` |
| `$viewport`, width | Integer | `{ $viewport: { field } }` `field: width` | The viewport's pixel width |
| `$viewport`, height | Integer | `{ $viewport: { field } }` `field: height` | The viewport's pixel height |
| `$time` | DateTime | `{ $time: { format?, timezone? } }` | The current date/time; serves a `Date` or `Time` host field too |

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
{ $var: { path, index? } }
```

- `path` — `datasource:location`, where the location is slash-separated (`PLC:Motor/Speed`). The datasource name before the `:` identifies which connection (and whether it's OPC-UA or static).
- `index` — optional array position. Present only when you pick one element of an array.

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
- **Out-of-range `index`** resolves to *absent* (see below), not an error — the same fallback rules apply.

### OPC-UA datatypes & the datasources manager

The types above are the vocabulary the **HMI** speaks. A datasource doesn't store them directly: every variable in the **datasources manager** carries its **real OPC-UA datatype** (`Boolean`, `Int16`, `Int32`, `UInt64`, `Float`, `Double`, `String`, `DateTime`, …). Those real types live only in the OPC layer — the datasource config, the write path, and the simulated server. At the HMI boundary each one is collapsed to a value type, so a field never sees `Int16` or `UInt64`, only `Integer`.

The map is `OPCUA_TO_SIMPLE` in `backend/core/value_types.py`, mirrored in
`frontend/src/shared/utils/valueTypes.ts`. Lookup is case-insensitive.

| OPC-UA datatype | Simple type |
|---|---|
| `Boolean`, `Bool` | `Boolean` |
| `SByte`, `Byte`, `Int8`/`16`/`32`/`64`, `UInt8`/`16`/`32`/`64`, `Enumeration` | `Integer` |
| `Float`, `Single`, `Double`, `Decimal` | `Float` |
| `String`, `ByteString`, `Guid`, `NodeId` | `String` |
| `DateTime` | `DateTime` |
| `Date` | `Date` |
| `Time` | `Time` |
| `Duration`, `TimeSpan` | `Duration` |
| *anything else* | `String` (fallback) |

- **The datasources manager is where the tree lives.** Browsing or editing a datasource records, per leaf, its real `data_type`, whether it's `writable`, and an explicit `is_array` plus optional positive `array_length` for fixed arrays. Folders organise, folders-with-variables become structs, and the same scalar / array / struct / struct-array shapes described above are exactly what `$var` binds to.
- **There are eight simple types, not five.** `VALUE_TYPES` is `Boolean`, `Integer`, `Float`, `String`, `DateTime`, `Date`, `Time`, `Duration` — `Date`, `Time` and `Duration` collapse from their own OPC-UA datatypes rather than riding on `DateTime`. `color`, `icon` and `image` are the exception: they have no OPC-UA datatype at all and exist only as field types, refined by the **field**, never by the variable.
- **The static datasource works in reverse.** It has no live server, so picking a simple type synthesises a *representative* OPC-UA type to store (`SIMPLE_TO_REPRESENTATIVE`): `Integer` → `Int32`, `Float` → `Double`, `Boolean` → `Boolean`, `String` → `String`, `DateTime` / `Date` / `Time` → `DateTime`, `Duration` → `Double`. The round trip is therefore lossy for `Date`, `Time` and `Duration` — a static `Date` reads back as `DateTime`.

---

## Resolution & quality

A source doesn't always produce a clean value. Three things can go wrong, and each has a defined outcome:

| Situation | What it means | Resolves to |
|---|---|---|
| **Absent** | The source can't produce a value yet (no `index` match, optional member not supplied, page param missing with no `default`) | `undefined` — the field uses its own fallback / placeholder |
| **Bad quality** | A `$var` is connected but the server reports the tag as bad/uncertain/stale | the field renders its **quality-degraded** state (typically blank or dimmed); the last good value is *not* silently reused unless the field opts in |
| **Disconnected** | The datasource itself is down | treated as bad quality for every `$var` it owns |

**Coercion.** A source's base type should match the field's base type. When they differ:

- `Integer`/`Float` → `String` and `Boolean` → `String` coerce with the field's display format.
- `Integer` and `Float` interconvert freely (`Float` → `Integer` rounds; `Integer` → `Float` is exact).
- `String` → `Integer`/`Float` coerces only if it parses cleanly; otherwise it's *absent*.
- Mismatches with no sensible coercion (e.g. `image` → `Float`) are rejected by the editor at bind time, not at runtime.

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

> The proxy will call any http(s) URL a caller names, so it is as reachable as
> the rest of the unauthenticated `/api` surface. Deployments exposing the HMI
> beyond the plant network should keep it behind the same network controls as
> every other endpoint.

---

## Component inputs in depth (`$componentProp`)

A component can declare **input properties** — values the parent fills in when placing it. Inside the component, children read those values with `$componentProp`:

```jsonc
{ "$componentProp": "motorVar" }
```

Each input has a **type**, exactly like any other field. So an input can be a `String`, `Integer`, `Float`, … or a **struct** (an object with named members). It may also carry a `description` (one line shown under the field) and a `defaultValue`.

One declared type is not an input at all: `widgets` names a [slot](data-formats.md#component-slots). It holds no value, so `$componentProp` cannot read it and the binding picker never offers it; what it declares is where the *caller's widgets* go.

### Defaults

`defaultValue` applies at runtime, not only in the editor: an instance that leaves a property `undefined` gets the declared default before the component's tree renders, so what the properties panel shows as the field's `· default` hint is what `$componentProp` resolves to. An explicit `null` is a *set* value — an author clearing a field on purpose — and does not fall back. Struct, `actions` and `widgets` properties have no default (a struct resolves to a variable subtree, an actions list to handlers, a `widgets` property to whatever the caller puts in the slot).

### `$componentProp` only substitutes as a whole value

The runtime rewrites a property whose **entire** value is `{ "$componentProp": "<key>" }` — that is what preserves the forwarded `$var`'s binding identity and keeps the value live. A `$componentProp` nested inside another source, or sitting anywhere outside `properties` (`layout` above all), resolves once and then stops updating.

Validation reports those as `componentprop-nested` warnings (`backend/core/component_validation.py`). The fix is to compute the derived value **on the instance** — instances may use `$var` and any other source freely — and pass the finished result in through a plain `$componentProp`.

### Struct inputs

A struct input declares its members up front. Some members are **required**, some are **optional**:

```jsonc
// in the component's input definition
{
  "sensor": {
    "type": "struct",
    "label": "Sensor",
    "fields": [
      { "name": "bEnabled", "type": "boolean" },           // required
      { "name": "fValue",   "type": "float", "write": true }, // required
      { "name": "label",    "type": "string", "optional": true } // optional
    ]
  }
}
```

- **Required members** — the parent *must* supply them. When binding the struct, only sources that actually provide every required member are accepted.
- **Optional members** — the parent *may* supply them. If left out, the member is simply absent at runtime.

### Reading a struct input

A child can bind the **whole struct**, or drill into **one member** by slash-path:

```jsonc
// the whole object { bEnabled, fValue, label? }
{ "$componentProp": "sensor" }

// a single member
{ "$componentProp": "sensor/fValue" }

// a nested member
{ "$componentProp": "sensor/stFiltered/bValue" }
```

### What happens to a missing optional member

There's no separate "default value" mechanism for struct members — an unsupplied optional member is just **absent**. A child that reads it gets nothing, so the component decides the fallback:

```tsx
const label = fields?.label ?? 'Sensor'   // optional → fall back when absent
const enabled = fields?.bEnabled === true  // required → safe to read directly
```

Rule of thumb: **required members are safe to read; optional members should always have a fallback.**

---

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

Implementation entry points: `frontend/src/hmi/utils/propertySourceEval.ts` (runtime), `frontend/src/hmi/utils/propertySourceRegistry.ts` + `propertySourceRules.ts` (sources per type), `frontend/src/shared/utils/valueTypes.ts` / `backend/core/value_types.py` (OPC-UA collapse), `backend/core/validation/structure.py` (`PROPERTY_SOURCE_KEYS`).
