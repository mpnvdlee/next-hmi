# Dynamic properties

The heart of NEXT HMI. Every property has a **type** and a **source** — it is either a plain value or a `$`-keyed object naming *where its value comes from*. The type a field needs is fixed by the field; you choose a **source** that produces it. Sources nest, so any property can react to live data with no scripting.

## Type vs. source

Two questions answer every property:

- **What type does the field need?** Decided by the field itself — a Label's **Text** wants a `String`, an Icon's **Size (px)** an `Integer`. You never pick the type.
- **Where does the value come from?** That's the **source** you pick — a literal, a tag, the user, a computed comparison…

> [!NOTE]
> **property value = a source that produces the type the field needs.** The editor only ever offers sources that can produce that type, so an impossible binding is impossible to make.

## The value types

Any of these can also be an **array**. An optional *format* refines the editor without changing the type — a `String` can present as a URL field, a dropdown, a password mask, a CSS-length input, a direction/align picker; a `Boolean` as a Visible/Hidden or Enabled/Disabled toggle.

`String`, `Integer`, `Byte`, `Float`, `Boolean`, `DateTime`, `Date`, `Time`, `Duration`, `color`, `icon`, `image`, `video`

A `Byte` is a whole number from 0 to 255 — what an OPC-UA `Byte` tag holds, a Siemens `BYTE` or `USINT` among them. A static datasource offers it as a data type, and the datasource table's **Live** column shows its value in hex: `16#0C`. Only a formula's `{1}` and a **Value Display** take a `Byte` tag.

## The sources

**Flexible** sources carry whatever type the field needs, so they fit almost anywhere. **Fixed-type** sources each produce one specific type and appear only on a property of exactly that type — a Float source is not offered on an Integer property, a Boolean one not on a String property. The one exception: a number also fills a `Duration`. A property that takes more than one type — a value that may be a Float or an Integer — offers every source that fits one of them.

| Source | Produces | Gives you |
|---|---|---|
| `$static` | flexible | A fixed value you type or pick (incl. icons & images). |
| `$var` | flexible | A live datasource / OPC-UA variable. |
| `$if` | flexible | One of two values chosen by a condition. |
| `$switch` | flexible | One of many values chosen by a key. |
| `$widgetProp` | flexible | A value exported by a sibling widget on the page. |
| `$componentProp` | flexible | A value passed in from outside — by the parent component, or by the **Open Dialog** action that opened this dialog. |
| `$overlay` | flexible | An input of a dialog while it is open, empty once it closes — so a symbol can light up while its own popover shows: compare `$overlay` (dialog *device*, input *device*) with the symbol's number. |
| `$result` | flexible | A field of an action's result (in its handlers only). |
| `$repeatItem` | flexible | The element a Repeater copy draws, one member of it, or its index (inside a Repeater only). |
| `$http` | flexible | A value picked out of an HTTP API response. |
| `$loc` · `$stringExpr` | String | Translated text, or a template like `Tank {1} of {2}`. |
| `$compare` · `$not` · `$and` · `$or` · `$pageIsActive` · `$userGroups` | Boolean | A comparison result, the opposite of another boolean, whether every (**AND**) or any (**OR**) condition in a list is true, whether a page is active, or whether the signed-in user is in one of the listed groups. |
| `$formula` | Float / Integer | A number calculated from other values, like `({1} - 32) / 1.8` or `{1} AND 16#0C` — arithmetic, one bit of a value, and bit operations; see [Calculate with a formula](#calculate-with-a-formula-formula). Empty when an input is missing or you divide by zero. **Round to a whole number** makes it an Integer; it is on from the start on a property that takes whole numbers. As the value of a **Write Data Variable** it can also go into an Integer tag: a whole result is written, a fraction is refused with `invalid_value`, as any number with decimals is. |
| `$user` | String / String[] | The signed-in user's name or groups, or the list of all users. |
| `$device` · `$urlParam` | String | This machine's identity (hostname, IP, MAC), or a parameter from the page URL. |
| `$viewport` | String / Integer | Screen size class, orientation, width, height. |
| `$time` · `$random` · `$alarmCount` | DateTime, Date, Time or String / Integer or Float / Integer | The clock as text in the format you pick, a random number, a live alarm count. |
| `$page` · `$languages` | String / Integer / String[] | Page metadata, and the configured language list. |
| `$recipe` · `$recipeList` | String / Boolean / Record[] | Recipe state, and the saved-recipe grid. |
| `$map` | the map's type | A value looked up in one of the project's [value maps](#reuse-a-lookup-value-maps-map). |

A source with a **Field** choice — Page, Viewport, Recipe, User, Device — lists only the fields that fit the property: on a whole-number property Page offers just **Depth**, Viewport just **Width** and **Height**.

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

## Reuse a lookup: value maps (`$map`)

When the same `$switch` turns up on many screens — an alarm severity that becomes a colour, a machine state that becomes text — define it once as a **value map** and point each property at it.

In the editor tree, **Value Maps** sits under **Global Events**. Press **+**, or right-click it › **Add Value Map**, to add a map; right-click a map to **Rename**, **Duplicate** or **Delete** it. In the properties panel give it an **Id**, a **Type** (Color, String, Boolean, Integer or Float), its **When → then** cases and a **Default**. On a String map a `then` can be a translation key. The maps are saved with the project, in `config.json`.

On a property, choose **Value Map** as the source, pick the map and set the **Value** it looks up — usually a tag:

```
"color": { "$map": { "id": "alarm-severity", "value": { "$var": { "path": "LinePLC:Alarms/Severity" } } } }
```

Only maps of the property's own type are offered. Cases are tried in order like a `$switch`'s, and with no match the map gives its default; a map without a default leaves the property empty, so the widget shows its own default. A property that names a map that is gone, or one of another type, shows up in the diagnostics. Renaming a map — in the tree or through its **Id** — takes every property that uses it along, on every page, dialog and component.

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
| `Round` · `Round1` · `Round2` · `Round3` · `Round4` | Nearest integer, or one to four decimals. |
| `Thousands` | Digit grouping — `41280` → `41,280`. It keeps the decimals its input has: `{Thousands(Round1(1))}` → `41,280.0`. |
| `Signed` | Always show the sign — `6` → `+6`, `-4` → `−4`, `0` stays `0`. Put it outermost so it keeps the decimals of an inner round: `{Signed(Round1(1))}` → `+6.0`. |

A placeholder whose wildcard is missing is left in the text as-is, so a typo shows up on screen rather than silently blanking the label.

The **template itself is literal text** — it is not translated. For a sentence
that must read naturally in every language, use **Localizable Text** instead:
its phrase holds the `{1}`, `{2}` placeholders and each language orders them
itself. See [Translations](translations.md#use-a-translation-on-a-screen).

## Calculate with a formula: `$formula`

A formula is written like Structured Text and gives a number. Write `{1}`, `{2}`, … for values: each gets its own row under the expression, where you pick what it is bound to — a number, a `Byte`, or a Boolean, which counts as 1 or 0. A link under the expression opens this section.

| What | Written as | Example |
|---|---|---|
| A value | `{1}`, `{2}`, … | `{1}` |
| Arithmetic | `+ - * /`, parentheses | `({1} - 32) / 1.8` |
| One bit, bit 0 the lowest | `.3` right after the value | `{1}.3` |
| Bit mask on a whole number | `AND OR XOR NOT` | `({1} AND 16#0C) / 4` |
| Shift | `SHL(x, n)`, `SHR(x, n)` | `SHR({1}, 4) AND 16#0F` |
| Hex and binary numbers | `16#`, `2#` | `16#0F`, `2#1100_0000` |

The order is that of Structured Text: parentheses first, then `NOT` and minus, `* /`, `+ -`, then `AND`, `XOR` and `OR` last. Keywords may be written in any case. A bit and the bit operators take whole numbers only: a fraction leaves the value empty, as a missing value or a division by zero does. `NOT` flips every bit of a signed number, so `NOT 0` is `-1` — mask the result to the width you mean: `NOT {1} AND 16#FF` for a `Byte`.

A bit read this way gives 1 or 0. A formula only reads: to show or switch one bit as a Boolean, bind the field to the bit itself with the picker's **Bits** box — see [Binding & subscribing](subscribing.md#bind-a-property-to-a-tag).

## Passing values into components

A reusable **Component** declares **input properties** the parent fills in. Inside, children read them with `$componentProp` — the whole struct, or one member by slash-path (`sensor/fValue`). Every member a struct input declares is required: the instance's binding picker confirms only a struct variable that carries each of them with a fitting type, and write access where a member asks for it. A member can still be absent at runtime — a disabled leaf, a value not yet arrived — so the widgets inside should not depend on it being there. Sibling widgets can read each other's exported state with `$widgetProp`. This is how one "Motor" component drives many motors from different tags.

Both reads are typed. The `$componentProp` and `$widgetProp` pickers judge each input or exported value against the field it would fill, exactly as the variable picker judges a tag — one that does not fit is marked ✗ and cannot be confirmed — and the value an instance puts into an input is checked against the input's type like any widget property. The warnings pill flags a stored read or value that does not fit.

### Value or Binding

Every input — of a component, a dialog, a page or a page group — has a **Kind**, chosen on its row:

| | **Value** | **Binding** |
|---|---|---|
| Whoever places or opens it passes | anything: text, a translation, a formula, a variable | a variable only, or a Binding it received itself |
| Read | once, when the instance appears or the dialog opens | live |
| A Write, Toggle, Edit Value or input field inside changes | its own copy, in this screen or instance only | the variable, on the controller |
| Goes back to whoever passed it | never | through the variable |
| Lasts | until the dialog closes, the page is left or the instance goes; opening again reads again | as long as the variable |

A **Value** is the screen's own state: a search filter on a recipe page, a jog speed in a motor dialog, a session flag inside a component. A second panel showing the same screen has its own copy and does not move along. A **Binding** is a tag: what it shows is what the controller has, and writing it writes the controller. A **Struct** input is always a Binding, and **Actions**, **Widget slot**, **Icon**, **Image**, **Video** and **Options** inputs have no kind — they pass through as given. Only a Binding takes **Write access** or loses its **Default value**: a Value is always writable, and a Binding gets its value from the variable.

Where an input is a Binding, the instance's or Open Dialog's row offers only the variable picker, and the warnings pill flags a fixed value, a formula or a Value input passed to it. A formula given to a Value is read once, and the warnings pill says so: to keep it live, pass the variable as a Binding and do the computing inside, with `$componentProp` in an `$if`, `$compare` or string expression. A page of the **Pages** section is opened by nothing, so it has only Values — its **Page Variables**, each starting at its default whenever the page opens.

An action inside the component can write through an input, too. Declare the input as a **Binding** with **write** access — a **Float** input `value`, say — and set the action's **Variable** row (Write Data Variable, Toggle Boolean Variable, Edit Value) to the input's source pill: the action writes whatever variable the instance passed in. One parameter-row component with an **Edit Value** button then edits a different setpoint per instance. The picker lists only Values and inputs declared writable, with a type the action writes, and the warnings pill flags one that is not. Point the same action at a Value input and it changes the instance's own copy instead. In the file:

```json
{ "type": "editValue", "target": { "$componentProp": "value" } }
```

The same works in a dialog, on an input parameter the opener fills with a variable.

Each input can carry a **description** (one line shown under the field) and a **default value**, used wherever an instance leaves the property empty — the default is what the component really renders with, not just an editor hint.

An input of type **Page** holds a page from the **Pages** section: whoever places the component picks it from a page picker, and a **Navigate To Page** inside the component goes to it, so one station card can lead each instance to its own station page. The warnings pill flags a page in the Dialogs folder or one that no longer exists. In the file it is `{ "type": "string", "label": "Target", "format": "page" }`.

An input of type **Select (enum)** gives whoever places the component a fixed list of choices instead of a free field. **Option values** decides what a choice actually hands over: **String**, **Integer**, **Float**, **Boolean** or **Localisable text**. Pick the kind that matches what the component does with it — a size list should pass a real number, a caption list a translation — so the value arrives usable rather than as text that has to be read back as a number. Change the kind later and the option labels stay put while their values clear, since a value written for the old kind means nothing under the new one.

An input of type **Options** passes a whole option list — `{ label, value }` pairs — so one dropdown component can offer a different list per instance. Inside, set the Dropdown's or Button Row's **Options** to `$componentProp: options`; each instance fills it with its own list, a bound array or another source the **Options** field takes, and the input's **Default value** is the list an instance that sets none gets. A label may be a translation, `{ "label": { "$loc": "pack.tray" }, "value": 1 }`, and shows in the active language; the list shows one line per option, value first, then the label; drag a line by its **⋮⋮** grip to move it, and click it to edit the option in the panel's drawer — the field's **⤢** opens every option there — where the label's source menu switches it between **Static Value** and **Localizable Text**.

Pages and page groups declare their **input parameters** in the same panel (see [Pages](pages.md)), so the option kinds apply there too.

A Binding input stays live wherever it sits: as a property's whole value (a Label's **Text** set to `$componentProp: title`), inside another source — the condition of an `$if`, a `$compare` operand, a wildcard of a string expression — or on a **Layout** field. A slash-path reaches into a struct input from there too, so a component given one device folder can colour a button with `$if` on `device/Func/stJogForward/bValue` and follow the tag as it changes. Inside an action list the input is read when the action fires.

### Passing widgets into a component (slots)

Input properties pass *values* in. A **slot** passes *widgets* in — the way you hand a card shell its body without the shell knowing what the body is.

1. **Name it** — In the component's **Properties** list, add a property of type **Widget slot** — `body`, say, labelled "Body". It takes no default and no value; it exists to name the slot so a **Component Slot** widget can pick it.
2. **Place it** — Add a **Component Slot** widget where the caller's content belongs and pick that property as its **Slot name**. Add as many as you need. In the editor's preview an empty slot is drawn as a labelled outline so you can see and size the hole you are authoring; on an operator screen an unfilled slot renders nothing at all.
3. **Fill it** — Place the component on a page. The instance gains a **Body** section in the widget tree: drop, drag, paste or right-click widgets there, or drop them straight into the slot in the preview. The slot holds widgets, not a value, so it gets no row in the properties panel.
4. **Who owns what** — Widgets you put in a slot stay yours: they select, bind and get properties on the page they live on. Everything the component itself draws is not selectable from the page — click it and the whole instance is selected. Edit those in the **Components** area.

Slots are structural: the set of slots is whatever **Component Slot** widgets the component contains. Remove one later and the widgets that filled it don't disappear — they move into the component's first slot, and the warnings pill tells you where.

The two halves belong together, and the warnings pill says so when they drift: a **Component Slot** that picks no property gives callers nowhere to aim, and a **Widget slot** property no **Component Slot** picks has nowhere to put content.

> [!TIP]
> **Sizing an instance works.** Size and growth set on the placed component apply to it as a whole — what's inside (direction, gap, padding) stays with the component's own design.

## Repeating widgets over an array (Repeater)

A **Repeater** draws the widgets inside it once for every element of an array — one row per motor, one tile per tank — so the screen grows and shrinks with the data.

1. **Pick the array** — Set the Repeater's **Items**: an array tag (`$var`), a list you type in, an API response that returns a list (`$http`), the saved recipes, or the users or user groups.
2. **Design one copy** — Put the widgets for a single element inside the Repeater, laid out the way one element should look. The Repeater's **Layout** decides how the copies line up (row, column, wrapping, gap).
3. **Bind to the element** — Inside, pick **Repeat Item** as a property's source and open its picker: the whole **Element**, one of its **members** (a struct field like `Speed`, or `label` / `value` of a typed-in list), or its **Index** (0 for the first). Like the variable picker it lists only what fits the property unless **Show all** is ticked. An API response or the saved recipes has a shape only the runtime knows, so for those you type the member's name into the field instead. A typed-in list's members take their type from what you typed: text is a String, Yes/No a Boolean, a whole number an Integer and a number with decimals a Float — so a Float property takes a `value` column only once one of its numbers has decimals. With the **Variable** source instead, every array in the picker gets a **[#] this copy** row that reads that array at the copy's position, the way `[2]` reads element 2: names next to setpoints. Typing `PLC:Names[#]` does the same.

**An icon or image per copy.** Set the Icon's (or Image's) own source to **Repeat Item** and pick the member that holds it: a built-in icon name (`warning`) or an asset path (`icons/door.svg`). That works whatever Items is — a tag array of String, a typed-in list, an API response. Hand-written files may instead put the Repeat item inside a fixed icon, `{ "$static": { "type": "custom", "path": { "$repeatItem": { "member": "icon" } } } }`; that fills in only when Items is a list of values, and the warnings pill flags it over a tag.

Each copy reads its own element. When Items is a tag, a copy's inputs write back to their own element too: a Switch bound to **Repeat Item** writes `Enables[3]` in the fourth copy, and **Write Data Variable** / **Toggle Boolean Variable** can switch their target to **Repeat Item**: always the copy's own element, or the member you pick of a struct element. Lists, API responses, recipes and users are read-only.

Inside an **Image Container**, **Place copies: At item x / y** draws each copy at the point its element names instead of in a row — see [Place one design many times from a list](layout.md#place-one-design-many-times-from-a-list).

**Start at** and **Max items** show part of the array — the first ten, or a page of it. **Empty text** is shown when there is nothing to draw.

In the editor the first copy is the one you edit; the others are drawn dimmed and select the first when clicked. With no data yet, one copy is still drawn so there is something to edit.

> [!NOTE]
> **Repeat Item only means something inside a Repeater**, and in a Data Grid's **On Select**. Anywhere else it is empty, and the warnings pill says so. A Repeater inside a Repeater reads its own elements — the outer one's are out of reach from inside it.

## Showing an array as a table (Data Grid)

A **Data Grid** shows an array as rows and columns — the recipe list, the event log — without a widget per row. It draws only the rows in view, so a PLC array of 500 elements stays fast.

1. **Pick the array** — **Items** takes the same sources as a Repeater's: an array tag, a typed-in list, an API response, the saved recipes.
2. **List the columns** — **Columns** lists one line per column, named by its title or else its member, as the **Options** list does: drag a line by its **⋮⋮** grip to move it, click it to open that column in the panel's drawer, or press the field's **⤢** to open them all, each folded to its line (`1 Id · 60px · right`), and **+ Add** to add one. In the drawer each column is a row you remove with its **×** and fold open or shut with its **›**. Each row sets the **member** it shows — picked from the struct when the grid knows the Items' members, typed otherwise — its **title**, from any source like a String property (text, a translation, a tag, a formula), a **width** — **Fill** shares the room the others leave, **Fixed** sets it in px — and its **align**ment, left, center or right. **Edit as JSON** shows the same list as `{"member": "nId", "title": "Id", "width": "60px", "align": "right"}` entries. Left empty, the grid shows a column per member of the first row. Text too long for its cell is cut off; every row has the same height.
3. **Sort and filter** — **Sort by** and **Sort direction** set the order the grid opens in. The operator clicks a header to sort on that column, and again to reverse it. **Filter member** with **Filter value** shows only the rows whose member contains the text, capitals or not — for a search field, add a page variable such as `RecipeFilter`, bind both **Filter value** and a String Input's **Variable** to it, and set the String Input's **Write on** to **Every key** so the list narrows as the operator types; a ✕ Button beside it with a **Write Data Variable** of `""` to the same page variable clears both. **Hide empty** drops every row whose member is empty, such as the unused slots of a fixed array.
4. **Selection** — **Value member** names the member that identifies a row (the recipe id). The picked row is published for other widgets as **Selected Item**, **Selected Index** (its position in Items, from 0) and **Selected Value** (the Value member as the row holds it, so a number id writes to an Integer tag); bind **Selected value** to a tag and the grid selects that row and scrolls it into view whenever the tag changes. Up, Down, Home and End move the selection from the keyboard.
5. **On Select** — runs when the operator picks a row. **Repeat Item** reads that row there: a **Write Data Variable** with the value `{"$repeatItem": {"member": "nId"}}` sends the picked recipe id to the PLC.

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

### Which servers a URL can reach

The live view is open to anyone on the network, so the HMI only calls servers the
project itself names. A URL with a fixed server — `https://mes.local/api/orders/{1}`
— names its own, and needs nothing else.

A URL that takes the server itself from a placeholder — `http://{1}/api/status`,
one line controller or another depending on a variable — names none. Such a URL
only reaches the servers you list under **Admin › HTTP sources** in the editor.
Write each one as scheme, server and port, for example `http://10.0.0.5:8080`.
Until the list holds the server a request goes to, that request is refused, and
the warnings pill reminds you while the list is empty. The machine the HMI runs
on can never be listed; to call a service on it, write its address in the URL
directly.

## Coercion, in short

- **A variable must match the field's type exactly.** A `Float` field takes no `Integer` tag and a `String` field no `Boolean` one; the binding picker will not confirm a tag that does not fit. A field that takes either lists both types.
- **A field that writes back takes only a tag.** A value field that a control writes to — a Button Row's value, a Video's state variable — offers just the **Variable** source (or Repeat Item / an input property standing in for one): no fixed value, formula or condition, since the control would have nothing to write to.
- **A widget reading a number** takes a number as-is, and text only when it is a clean decimal number (`"42"`, `"-1.5"`); anything else is *absent* and the field falls back. Nothing is rounded.
- **A widget reading text** turns a number or a boolean into its plain text (`3.5`, `true`); decimals and units are the widget's own formatting.
- Impossible bindings (image → Float) are rejected by the editor at bind time — never at runtime.
