# Dynamic properties

The heart of NEXT HMI. Every property has a **type** and a **source** — it is either a plain value or a `$`-keyed object naming *where its value comes from*. The type a field needs is fixed by the field; you choose a **source** that produces it. Sources nest, so any property can react to live data with no scripting.

## Type vs. source

Two questions answer every property:

- **What type does the field need?** Decided by the field itself — a Label's **Text** wants a `String`, an Icon's **Size (px)** an `Integer`. You never pick the type.
- **Where does the value come from?** That's the **source** you pick — a literal, a tag, the user, a computed comparison…

> [!NOTE]
> **property value = a source that produces the type the field needs.** The editor only ever offers sources that can produce that type, so an impossible binding is impossible to make.

## The value types

Any of these can also be an **array**. An optional *format* refines the editor without changing the type — a `String` can present as a URL field, a dropdown, a password mask, a CSS-length or spacing box, a direction/align picker; a `Boolean` as a Visible/Hidden or Enabled/Disabled toggle.

`String`, `Integer`, `Float`, `Boolean`, `DateTime`, `Date`, `Time`, `Duration`, `color`, `icon`, `image`

## The sources

**Flexible** sources carry whatever type the field needs, so they fit almost anywhere. **Fixed-type** sources each produce one specific type and appear only where it fits.

| Source | Produces | Gives you |
|---|---|---|
| `$static` | flexible | A fixed value you type or pick (incl. icons & images). |
| `$var` | flexible | A live datasource / OPC-UA variable. |
| `$if` | flexible | One of two values chosen by a condition. |
| `$switch` | flexible | One of many values chosen by a key. |
| `$widgetProp` | flexible | A value exported by a sibling widget on the page. |
| `$componentProp` | flexible | A value passed in by the parent component / dialog. |
| `$result` | flexible | A field of an action's result (in its handlers only). |
| `$http` | flexible | A value picked out of an HTTP API response. |
| `$loc` · `$stringExpr` | String | Translated text, or a template like `Tank {1} of {2}`. |
| `$compare` · `$pageIsActive` · `$userGroups` | Boolean | A comparison result, whether a page is active, or whether the signed-in user is in one of the listed groups. |
| `$user` | String / String[] | The signed-in user's name, or their groups. |
| `$device` · `$urlParam` | String | This machine's identity (hostname, IP, MAC), or a parameter from the page URL. |
| `$viewport` | String / Integer | Screen size class, orientation, width, height. |
| `$time` · `$random` · `$alarmCount` | DateTime / Float / Integer | The clock, a random number, a live alarm count. |
| `$page` · `$languages` | String / Integer / String[] | Page metadata, and the configured language list. |
| `$recipe` · `$recipeList` | String / Boolean / Record[] | Recipe state, and the saved-recipe grid. |

## They nest — a worked example

The power is in composition. Here a Label's text is a live tag and its colour is driven by a second one — the motor's temperature — all in one property block:

```
"text": { "$var": { "path": "LinePLC:Motor1/Speed" } },
"color": {
  "$if": {
    "condition": { "$compare": {
      "left":  { "$var": { "path": "LinePLC:Motor1/Temp" } },
      "operator": ">", "right": 120
    } },
    "true":  "#e5484d",   // hot → red
    "false": "#2563eb"    // normal → blue
  }
}
```

## Choose between values: `$if`, `$compare` and `$switch`

Three sources cover almost every "it depends" on a screen, and they are usually used together.

**`$compare`** produces a Boolean by comparing two values, each of which is itself a property — so both sides can be tags, constants, or anything else. Operators: `>`, `<`, `>=`, `<=`, `===` (equal), `!==` (not equal). The ordering operators compare numerically; equality is forgiving about `5` vs `"5"`.

**`$if`** picks one of two values from a Boolean condition — typically a `$compare`, but any Boolean source works (`$userGroups`, `$pageIsActive`, a `$var` on a bool tag).

**`$switch`** picks from many, by matching a value against a list of cases with a fallback. Use it wherever a PLC state number has to become text, a colour, or an icon:

```
"label": {
  "$switch": {
    "value": { "$var": { "path": "LinePLC:Line3/State" } },
    "cases": [
      { "when": 0, "then": { "$loc": "Stopped" } },
      { "when": 1, "then": { "$loc": "Running" } },
      { "when": 2, "then": { "$loc": "Fault" } }
    ],
    "default": { "$loc": "Unknown" }
  }
}
```

Cases are tried in order and the first match wins. Both `when` and `then` are full properties, so a case can match against a tag and return another one. A `$switch` with three cases replaces the three-deep nest of `$if`s that would otherwise be needed — reach for it as soon as there is a third branch.

## Build a string from parts: `$stringExpr`

`$stringExpr` is a template with numbered placeholders, each filled by its own binding:

```
"text": {
  "$stringExpr": {
    "template": "Tank {1}: {Round1(2)} °C",
    "wildcards": {
      "1": { "$var": { "path": "LinePLC:Tank/Id" } },
      "2": { "$var": { "path": "LinePLC:Tank/Temp" } }
    }
  }
}
```

A placeholder may wrap its value in transform functions, applied inside-out:

| Function | Does |
|---|---|
| `ToLower` · `ToUpper` · `Capitalize` · `Trim` | Case and whitespace. |
| `Round` · `Round1` · `Round2` | Nearest integer, or one / two decimals. |
| `Thousands` | Digit grouping — `41280` → `41,280`. |

A placeholder whose wildcard is missing is left in the text as-is, so a typo shows up on screen rather than silently blanking the label.

The **template itself is literal text** — it is not a bindable property. To keep a
templated line translatable, put the words in the wildcards (`$loc`) and leave
only structure and punctuation in the template: `"{1}: {Round1(2)} °C"` with
wildcard `1` a `$loc`. See [Translations](translations.md#use-a-translation-on-a-screen).

## Passing values into components

A reusable **Component** declares **input properties** the parent fills in. Inside, children read them with `$componentProp` — the whole struct, or one member by slash-path (`sensor/fValue`). Required members must be supplied; optional ones fall back when absent. Sibling widgets can read each other's exported state with `$widgetProp`. This is how one "Motor" component drives many motors from different tags.

Each input can carry a **description** (one line shown under the field) and a **default value**, used wherever an instance leaves the property empty — the default is what the component really renders with, not just an editor hint.

> [!IMPORTANT]
> **`$componentProp` has to be the whole value of a property.** Use it directly — a Label's **Text** set to `$componentProp: title` — and it stays live. Bury it inside another source (as one arm of an `$if`, a wildcard of a string expression) or put it on a **Layout** field, and it fills in once and then stops updating. The warnings pill flags this. Do the thinking on the *instance* instead: the instance may bind `$var`, compare, format — then pass the finished value in through a plain `$componentProp`.

### Passing widgets into a component (slots)

Input properties pass *values* in. A **slot** passes *widgets* in — the way you hand a card shell its body without the shell knowing what the body is.

1. **Name it** — In the component's **Properties** list, add a property of type **Widget slot** — `body`, say, labelled "Body". It takes no default and no value; it exists to name the slot so a **Component Slot** widget can pick it.
2. **Place it** — Add a **Component Slot** widget where the caller's content belongs and pick that property as its **Slot name**. Add as many as you need. In the editor's preview an empty slot is drawn as a labelled outline so you can see and size the hole you are authoring; on an operator screen an unfilled slot renders nothing at all.
3. **Fill it** — Place the component on a page. The instance gains a **Body** section in the widget tree: drop, drag, paste or right-click widgets there, or drop them straight into the slot in the preview. The slot holds widgets, not a value, so it gets no row in the properties panel.
4. **Who owns what** — Widgets you put in a slot stay yours: they select, bind and get properties on the page they live on. Everything the component itself draws is not selectable from the page — click it and the whole instance is selected. Edit those in the **Components** area.

Slots are structural: the set of slots is whatever **Component Slot** widgets the component contains. Remove one later and the widgets that filled it don't disappear — they move into the component's first slot, and the warnings pill tells you where.

The two halves belong together, and the warnings pill says so when they drift: a **Component Slot** that picks no property gives callers nowhere to aim, and a **Widget slot** property no **Component Slot** picks has nowhere to put content.

> [!TIP]
> **Sizing an instance works.** Size, growth and margins set on the placed component apply to it as a whole — what's inside (direction, gap, padding) stays with the component's own design.

## Reading a value from an API (`$http`)

`$http` binds a field to something an HTTP endpoint returns — an order number
from the MES, a setpoint from a REST service, an outside temperature.

- **URL** — the endpoint. It accepts `{1}`, `{2}`, … placeholders exactly like a
  string expression, so a URL such as `https://mes.local/api/orders/{1}` can
  target a different order as a variable changes. Each placeholder gets its own
  binding row underneath.
- **Method / Body** — `GET` by default; pick `POST` to send a request body, which
  is templated the same way.
- **Response path** — a slash-path into the JSON that came back
  (`data/0/value`). Leave it empty to use the whole response. A path that finds
  nothing leaves the field on its fallback, exactly like any unset source.
- **Refresh** — seconds between polls. `0` fetches once and keeps the answer for
  the session.

Until the first response arrives the field shows its fallback; the real value
appears as soon as the request completes, and again on every refresh.

## Coercion, in short

- `Integer` ↔ `Float` convert freely (Float → Integer rounds).
- Numbers and booleans → `String` use the field's display format.
- A `String` → number only if it parses cleanly, else *absent*.
- Nonsense conversions (image → Float) are rejected by the editor at bind time — never at runtime.
