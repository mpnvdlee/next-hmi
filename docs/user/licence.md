# Licence

NEXT HMI is free and open-source software under **AGPL-3.0**. Most people who run it owe nothing and pay nothing, forever. This page is the short, practical version; the binding text is in [LICENSING.md](../../LICENSING.md) and [LICENSE](../../LICENSE).

## What you get, free

The open-source build is the whole product. Historian, alarms, recipes, users and groups, peer transfer, the editor, the custom-widget SDK — all of it is in the box.

In the open-source build there is **no licence key, no feature unlock and no runtime check** anywhere in the code. Nothing phones home, nothing expires, nothing counts your tags, your screens or your operators.

> [!NOTE]
> A separate **enterprise build** exists for regulated plants that need an audit
> trail. It is proprietary, is not this build, and *is* activated with a licence
> key — if your manager opened on an activation screen asking for one, you are
> running it, and its own **Licensing** page covers what the key does. Nothing on
> this page changes: the enterprise build is an addition, not a piece taken out
> of the free one.

## Does the AGPL ask anything of me?

Almost certainly not. Its obligations start only when you **redistribute a build** or **serve a modified build over a network** — and then only for changes to the *platform*.

| What you're doing | What the AGPL asks |
|---|---|
| Running NEXT HMI on your plant network, unmodified — commercially, at any scale | Nothing. |
| Building projects, widgets and themes with it | Nothing. Your project content is yours (see below). |
| Handing a colleague the official zip | Nothing beyond passing the licence along. |
| Shipping a **modified** NEXT HMI inside your machines | Offer your recipients the source of what you shipped — or buy a commercial licence instead. |
| Offering a **modified** NEXT HMI as a hosted service | Same, under AGPL §13, to your network users. |

The AGPL never requires payment. A commercial licence is the *alternative* to complying with the source-disclosure terms, not a fee the licence imposes.

## Your project content is yours

The copyleft covers the platform — backend, runtime, editor. It does **not** reach the content you author with it:

- pages, layouts, widget trees and property expressions
- themes and token overrides
- translations
- datasource configurations
- alarms, recipes, users, and the rest of the per-project configuration
- **custom widgets** you author under `custom-widgets/<Name>/index.tsx`

You own all of it outright. Keep it private, license it how you like, ship it as part of a commercial product — with no obligation to release it under the AGPL and no obligation to disclose it under §13. This is stated explicitly so that a strict reading of "derivative work" can't be used to claim otherwise; the full text is in [LICENSE-EXCEPTION.md](../../LICENSE-EXCEPTION.md).

A custom widget consumes documented runtime globals on `window.__nextHMI__`. Using a documented interface does not make your widget a derivative of the platform.

## The attribution notice

Every load of the operator runtime shows a boot screen with the product logo and the AGPL-3.0 notice, for a minimum of two seconds. That notice is the open-source build's attribution.

The open-source build has no setting for it: the notice is bound to the edition, not to project configuration. White-labelling requires a commercial licence, whose build drops the notice and adds a single **Boot logo** setting (`shell.bootLogo`) that puts your own logo on the boot screen in place of the product mark and name.

That setting is bound to the edition too — the open-source build ignores it, so a white-labelled project opened there shows the product branding again. Nothing verifies a licence at runtime, in either build.

## When you'd want a commercial licence

Three situations, none of which apply to a plant that just runs the thing:

- **You redistribute a modified build** — a machine builder embedding NEXT HMI in shipped equipment, an integrator delivering a modified build to clients, a SaaS vendor hosting one. Priced per shipped unit.
- **You want to white-label** — replace the boot-screen logo with your own and drop the notice.
- **You want support, an SLA, or a contractual counterparty** — available to everyone, including AGPL users who never redistribute. It adds a support relationship, never a different binary. Release binaries are currently unsigned; when signing lands it applies to the public release for everyone, not as a paid tier.

How to buy is in [COMMERCIAL.md](../../COMMERCIAL.md).

## Bundled third-party components

Two runtime dependencies are LGPL rather than AGPL — **asyncua** (the OPC-UA client) and **zeroconf** (LAN peer discovery), both used unmodified. In the portable and Docker builds they ship as loose, replaceable package directories under `lgpl/` beside the executable rather than frozen inside it, so a recipient can substitute their own build. Their full licence texts travel with every release.

The complete third-party inventory is in [NOTICE](../../NOTICE).
