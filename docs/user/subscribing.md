# Binding & subscribing

Binding a property to a variable is the whole subscription. Point a field at a tag with `$var`, and the server subscribes on your behalf and streams updates to the screen. Writable tags flow the other way.

## How the live pipeline works

Three hops, two protocols:

| | Hop | Carried over |
|---|---|---|
| **PLCs** | The server subscribes, writes and browses. | OPC-UA |
| **FastAPI server** | Holds the connection pool; fans values out to every screen. | WebSocket |
| **Operator screens** | Widgets re-render on each update to their tags. | — |

A browser only ever subscribes to the tags actually on screen. A viewport-aware **fast / slow window** refreshes visible tags first, so what the operator is looking at stays the freshest. Two things join that fast set regardless of what is on screen: [alarm](alarms-recipes.md) trigger tags and [historized](historian.md) variables. The **Admin** area lists the whole set live — see [Diagnostics](diagnostics.md#fast-subscriptions).

## Bind a property to a tag

1. **Select the widget and its field** — e.g. a Label's **Text**. Click the field's **source pill** and choose **Variable**.
2. **Pick the tag from the tree** — The variable picker shows your datasources' trees. Choose a leaf — say `LinePLC:Motor1/Speed`. For an array, also choose the **index** to bind one element; leave it off to bind the whole array.
3. **Watch it go live** — The canvas immediately reflects streamed values. That's the subscription — there's nothing else to register.

```
// a scalar tag
"value": { "$var": { "path": "LinePLC:Motor1/Speed" } }

// one element of an array
"value": { "$var": { "path": "LinePLC:Readings", "index": 0 } }

// a whole struct member reached by slash-path
"value": { "$var": { "path": "LinePLC:Motor1/Torque" } }
```

The `path` is always `datasource:location`, with the location slash-separated. The prefix before the colon names the connection.

## Write back to the machine

Mark a variable **writable** when browsing, and controls can push values to it. A **Button** binds a struct with `bVisible`, `bEnabled` and a writable `bValue` — press it and the runtime sends a `write_field` message that sets the tag. A numeric setpoint written from a numpad works the same way.

## What happens when data goes bad

The runtime turns failure into a defined visual state — never a stale value passed off as live, and never a crash.

| Situation | Result |
|---|---|
| **Absent** | Source can't produce a value yet (no matching index, optional input not supplied) → the field uses its own fallback / placeholder. |
| **Bad quality** | The tag is connected but reported bad / uncertain / stale → the field shows its quality-degraded state (blank or dimmed). |
| **Disconnected** | The datasource itself is down → treated as bad quality for every tag it owns. |

## The marks on a widget

A widget whose bindings aren't delivering gets an overlay, and which one it is
tells you where to look:

| Mark | Means | Fix |
|---|---|---|
| **Red — wrong binding** | The binding itself doesn't resolve: a tag that no longer exists, a member that isn't on the struct, an index past the end of the array. | A configuration error — repair the binding. |
| **Amber — no data** | The binding is sound, but no value has arrived. | Look at the datasource, not the page — see [Connect, disconnect, and see why it failed](datasources.md#connect-disconnect-and-see-why-it-failed). |
| **Dashed — disconnected** | The socket or the datasource is down, so every tag it owns is suspect. | Connectivity. Cached values are never passed off as live here. |

The amber mark waits for the server to say it has sent everything it is going
to for this screen, so a value merely still in flight is never flagged. If that
signal never comes — the backend is down — it appears anyway after a few
seconds rather than hiding the problem. Dialogs are judged on their own
delivery, not the page's, so opening one doesn't inherit a window that already
closed.

> [!NOTE]
> **A slow tag no longer holds up the screen.** A page reveals once its widgets'
> code has loaded — its *variables* are not part of that wait. A slow OPC-UA read
> shows up as an amber mark on the one widget waiting for it, instead of stalling
> the whole navigation.
