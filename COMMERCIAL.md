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

Grants four things:

- **No copyleft obligation** on redistribution or network serving.
- **White-labelling.** The open-source runtime shows a NEXT HMI logo and
  AGPL-3.0 notice on every boot, minimum two seconds. The enterprise build drops
  the notice and honours a `shell.bootLogo` project setting for your own mark.
  Both are properties of the *edition*: the open-source build ignores `bootLogo`
  and always shows the notice, whatever a project file says. Shortening the two
  seconds without this licence is a contract violation, not something the
  software blocks.
- **A signed binary.** The enterprise build is code-signed; the public downloads
  are not — see [Signing](#signing).
- **Key re-issue**, free and unlimited, whenever hardware is replaced.

**White-labelling therefore means the enterprise build, and that build is
activated.** A redistribution licensee is delivered the enterprise build plus
one key per device, bound to that machine — see the activation section for
exactly what the key does, which is less than it sounds. There is no third,
unactivated "commercial build": the edition seam has two values, `oss` and `ee`.
The open-source build in this repository contains no licence check at all and
never will.

Priced **per device** — one fee per NEXT HMI server that leaves your
building, perpetual for devices already delivered, with no renewal and no
expiry. One server is one device; the browser screens on it are never counted,
so a panel PC and twenty tablets are one licence. Current prices and volume
tiers are at **[next-hmi.com/pricing](https://next-hmi.com/pricing)**.

The tier is set by what you take in the running contract year, and there is no
minimum: five machines a year is five times the tier price, with nothing to
administer between the transactions.

**What the licence does not include:** support, a response time or an SLA,
installation and commissioning, any bugfix or hotfix commitment, custom
development, or PLC work. It grants white-label, release from the AGPL source
obligation, a signed build, and key issuance — nothing more, which is what keeps
it a decision rather than a negotiation. Those other things are real and can be
bought separately; see [Support and commissioning](#support-and-commissioning).

### Fixing a bug yourself

"Fix it yourself" is a promise about the platform, not about the enterprise
layer. Three steps, in order:

1. **The platform is yours.** Read it, patch it, rebuild it — a hundred per cent
   of what draws your screens is in this repository.
2. **To get that patch into a white-labelled installation**, send it in; we
   build and sign an `ee` binary from it.
3. **If that takes too long**, patch the core and run the public build. Your
   project keeps running; you lose the boot logo and the audit-trail module
   until the signed build catches up.

Step 3 is the one that matters: you are never blocked on us. You choose between
waiting and giving up your own mark for a while.

## Audit-trail module

Adds an **audit trail** — an append-only, attributed record of operator actions
— for plants under regulatory audit requirements. Separate build, its own
add-on key on top of the runtime licence, code not in this repository.

Priced **per installation**, once, perpetual — one fee per plant that switches
it on, whatever number of devices that plant runs. Not a subscription; see
[next-hmi.com/pricing](https://next-hmi.com/pricing).

It is the only paid module today. What separates a paid module from the free
build is scale and regulatory pressure, never a feature held back: alarms, the
historian, recipes, users and the editor are in the open-source build and stay
there.

What exists today is the recording and an audit panel to read it in: sign-in and
sign-out, successful writes to equipment, alarm acknowledgements, each marked
`verified` or `claimed`. The packaged compliance module on top — exports,
retention controls, the documentation a quality department signs off — is still
being built, and its scope is set with the first customer who needs it. Neither
today's recording nor that module is on its own a 21 CFR Part 11 package: there
is no integrity chain over the file and no electronic-signature capture.

## Activation

The enterprise build is activated; the open-source build is not, and never will
be. What the key does, in full:

- An unactivated build serves its manager (where you paste the key) but starts
  no project.
- The check runs only when a project *starts*. It is never applied to one
  already serving screens, so no licence state can take a running line down.
- **A purchased key carries no expiry date.** Not a long one — none. The only
  key with a date inside it is the trial issued from
  <https://next-hmi.com/trial>.
- Keys are bound to one machine, in fuzzy mode by default, which tolerates one
  changed component. Re-issue after a hardware replacement is free and
  unlimited — it is licence administration, not billable work.
- Nothing phones home. Verification is a signature check against a public key
  compiled into the build, so an air-gapped plant activates like any other.

## Signing

**The public downloads are unsigned.** Windows and macOS portable builds ship
without Authenticode or Developer ID, so SmartScreen and Gatekeeper warn on
first launch; run from source or Docker if plant IT forbids that.

That is not a temporary state waiting on a certificate. A signed build is one of
the things the redistribution licence buys, so an IT policy that refuses
unsigned executables is a reason to license rather than a defect to report. The
enterprise build is signed; nothing about the open-source build changes either
way, and it stays complete and free.

## Support and commissioning

Open to everyone, including AGPL users who never redistribute: commissioning,
migrations and upgrades, custom widgets, PLC integration, a configuration
review, a real invoice, and a contractual counterparty. It adds a relationship,
never a different binary.

The default is that you commission your own work. A builder or integrator
shipping the panel does its own implementation and stays its customer's point of
contact; we maintain and develop the product. Hours on the product itself — a
custom widget, a migration across a platform version — are quoted per
assignment.

Sold **separately from any licence, and never as a subscription**. There are no
support packages, no tiers and no response-time commitments — a guaranteed
response on every working day of the year is the one thing a small team cannot
honestly promise, so it is not sold rather than sold badly. Work goes per
assignment, planned by agreement, quoted for the piece of work.

What stays free for everyone: GitHub issues, the documentation, and every
release.

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

## Your project content

Pages, themes, translations, datasource configurations and the custom widgets
you author are your own work, not a derivative of the platform: the copyleft
reaches forks of NEXT HMI, not the projects built on it. That is stated for the
AGPL in [LICENSE-EXCEPTION.md](LICENSE-EXCEPTION.md), and it carries into the
commercial licence unchanged — buying one takes nothing away here, and needing
it is never about your project files.

## How to buy

Everything — redistribution licences, the audit-trail module, support,
commissioning — goes through <mailto:licensing@next-hmi.com>. Say what you are
building and who receives it; you get a straight answer, including "you do not
need to buy anything" when that is the true one.

Trial keys for the enterprise build: <https://next-hmi.com/trial>.
