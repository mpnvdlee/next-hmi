# Commercial licensing

NEXT HMI is free and open-source under [AGPL-3.0](LICENSING.md). **Most users
need nothing on this page** — a factory self-hosting an unmodified build owes
nothing, forever, even in production, even commercially, even for many
operators.

The AGPL only asks something of you when you **redistribute a build** or
**network-serve a modified one**: then §13 requires you to offer recipients the
complete corresponding source of what you shipped. A commercial licence is the
alternative to doing that — not a fee the licence imposes.

This page says who each paid option is for and how to buy. It is not the licence
text — ask <mailto:licensing@next-hmi.com> for that.

## Redistribution licence

For OEMs and machine builders embedding NEXT HMI in shipped equipment,
integrators delivering modified builds, and SaaS vendors serving a modified
NEXT HMI.

Grants two things:

- **No copyleft obligation** on redistribution or network serving.
- **White-labelling.** The open-source runtime shows a NEXT HMI logo and
  AGPL-3.0 notice on every boot, minimum two seconds. The commercial build drops
  the notice and adds a `shell.bootLogo` project setting for your own mark. Both
  are properties of the build, not a runtime licence check — the open-source
  build ignores `bootLogo` and always shows the notice. Shortening the two
  seconds without this licence is a contract violation, not something the
  software blocks.

Priced **per shipped unit** — one fee per machine or panel that leaves your
building with NEXT HMI on it, perpetual for units already delivered. Enforced by
contract only; the open-source build contains no licence check at all. Ask
<mailto:licensing@next-hmi.com> for a quote against your volume.

## Enterprise module subscription

Adds a compliance **audit trail** — a tamper-evident record of operator actions
— for plants under regulatory audit requirements. Separate signed build, own
per-device key, commercial licence, code not in this repository.

Unlike the open-source build, this one is **activated**. Details worth knowing:

- An unactivated build serves its manager (where you paste the key) but starts
  no project.
- The check runs only when a project *starts*. A lapsed key cannot stop a
  running line; it refuses the next start.
- Nothing phones home — the expiry is a date inside the signed key.
- The open-source build in this repository has no licence check and never will.

## Support and commissioning

Open to everyone, including AGPL users who never redistribute: commissioning
help, priority support, an SLA, a real invoice, and a contractual counterparty.
It adds a relationship, never a different binary.

**Release binaries are currently unsigned.** Windows and macOS portable builds
ship without Authenticode or Developer ID today, so SmartScreen and Gatekeeper
warn on first launch; run from source or Docker if plant IT forbids that. When
signing lands it applies to the public release for everyone — it will not become
a paid tier.

## Bundled LGPL components

Two backend dependencies are LGPL and used unmodified: **asyncua** (OPC-UA
client, LGPL-3.0-or-later) and **zeroconf** (LAN discovery, LGPL-2.1-or-later).
This matters to commercial licensees, who don't get the AGPL's automatic source
provision.

- Source installs import both from `site-packages` — independently replaceable
  there.
- Binary builds (portable, Docker) ship them as loose package directories under
  `lgpl/` beside the executable rather than frozen inside it, so a recipient can
  swap in their own build. Licence texts travel with the build
  (`LICENSE-LGPL-3.0.txt`, `LICENSE-GPL-3.0.txt`, `LICENSE-LGPL-2.1.txt`).

**Written offer for source.** Upstream publishes it:
[asyncua](https://github.com/FreeOpcUa/opcua-asyncio),
[zeroconf](https://github.com/python-zeroconf/python-zeroconf). The `lgpl/`
directories in a release are themselves the complete corresponding source for
the exact versions shipped; on request we send them directly
(<mailto:licensing@next-hmi.com>).

## How to buy

Everything — redistribution licences, the enterprise module, support,
commissioning — goes through <mailto:licensing@next-hmi.com>. Say what you are
building and who receives it; you get a straight answer, including "you do not
need to buy anything" when that is the true one.

Trial keys for the enterprise build: <https://next-hmi.com/trial>.
