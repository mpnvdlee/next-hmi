# Manager Peer Transfer

**Canonical** home for the manager-to-manager LAN transfer feature — trust
model, operator workflow, collision handling, and reliability guarantees. Wire
contract (request/response shapes) lives in
[rest-api.md § Manager peer transfer API](rest-api.md#manager-peer-transfer-api);
this doc explains what those endpoints do and why.

## What it is

Two NEXT HMI managers on the same trusted LAN can send a project directly to
each other — no shared filesystem, no manual zip/unzip. Either side can push
(send a local project to a peer) or pull (fetch a project from a peer). It is
strictly manager-to-manager: a bare project instance (`backend/main.py`) never
advertises itself and never accepts a peer connection — see
[backend.md](../architecture/backend.md#main-modules).

## Trust model

- **Verify before sign-in** — mDNS records (address, port, hostname, scheme,
  runtimeId) are unauthenticated: anything on the LAN can advertise
  `_nexthmi._tcp` at its own address. So pairing is two calls. `POST
  /api/manager/peer-probe` sends nothing: it reads the certificate the peer
  presents and, over a connection anchored on exactly that certificate, the
  peer's public `GET /api/manager/peer/info` (`{ runtimeId, hostname }`). The
  operator compares the SHA-256 with the one the peer's own Settings › HTTPS
  shows. `POST /api/manager/peer-pair` then has to carry that confirmed
  `fingerprint`; the manager re-reads the certificate and anchors the pairing
  request's TLS handshake on it, so a different certificate fails the
  handshake before the password is written. On any mismatch no password is
  sent.
- **Pairing** — the initiator authenticates once with the *destination's*
  existing device-admin password (`POST /api/manager/peer/pair`). The destination returns a
  random bearer token and persists only its SHA-256 digest; the plaintext
  token lives in the transfer modal's component state (never web storage) —
  or, when the operator keeps **Remember this device** (the default), on the
  initiating manager in `<runtime_home>/.peer-pairings.json` (`0600`, written
  through `write_text_atomic`), keyed by the peer's runtimeId and bound to the
  certificate it was paired over. A remembered token is only sent over a
  handshake anchored on that certificate (`peer_tokens.remembered`), so the
  next transfer to the device needs no password. Plain-HTTP pairings are never
  remembered.
- **Tokens** are individually revocable (`DELETE /api/manager/peer-tokens/{tokenId}`;
  the dashboard has no control for it) and are all revoked automatically when
  the device-admin password changes (`authGeneration` pinning in
  `core/peer_tokens.py`).
- **Transport** is HTTPS for pairing. A plain-HTTP peer is refused ("Pairing
  needs HTTPS on the other device") unless the request carries
  `allowInsecureHttp`, which the modal sends only after the operator ticks the
  "isolated network" acknowledgement — bearer auth stops unauthenticated
  mutation but does not encrypt the pairing password, token, or archive in
  transit. A discovered peer advertises the scheme it serves in its TXT
  record.
- **Pins** (`core/peer_trust.py`, `<runtime_home>/.peer-trust.json`) are
  written only for a certificate the operator confirmed — there is no trust on
  first use. Each pin is keyed by the address it was confirmed at and records
  the peer's runtimeId, which is persistent per runtime home
  (`.peer-identity.json`). A probe that finds the confirmed certificate under
  the same runtimeId at a new address pins that address too (same device); a
  pin for the address or the runtimeId that names a *different* certificate
  makes the probe report `trust: "changed"` and the pairing a `409` "Certificate
  changed: pairing stopped" — never a silent re-pin. Every later handshake
  must present the pinned certificate before any token or project byte is
  sent; a token is never sent to an `https` peer without a pin. A pinned peer
  is never spoken to over plain HTTP again, whatever scheme a TXT record
  claims, and an HTTP probe answering with a pinned runtimeId reads as
  `changed`. A renewed peer certificate breaks transfers until its pins are
  dropped (`DELETE /api/manager/peers/trust`, which drops every pin of the same
  runtimeId) and the new certificate confirmed, by design.
- **Pulled code** — a project's custom widgets, the `.js`/`.mjs` files of its
  `external-libraries/` and the keys of its `external-modules.json` are code
  the puller serves to every browser that opens the project
  (`widget_compiler.project_code`; see
  [custom-widgets.md](custom-widgets.md#security-editor-access-is-code-execution)).
  The peer's project listing names them per project (`code: { customWidgets, externalLibraries,
  importOverrides }`, beside the older `customWidgets` count); the modal lists
  them and requires "I trust the source of this project and want to run its
  code" whenever any is named or `code` is missing. The pull itself reads the
  same three from the project extracted into its staging folder and fails
  before installing anything unless the request carried
  `trustCustomWidgets: true` — the listing is only the source's word. An
  archive member with a `.`, `..` or empty path segment is refused while
  unpacking, so no member name can hide where it lands.
- **Address pinning** — outgoing connections resolve the peer hostname once
  and pin the HTTP connection to that private unicast address. Public, mixed
  public/private, link-local, multicast, and unspecified answers are
  rejected; loopback requires an explicit deployment override
  (`NEXTHMI_ALLOW_LOOPBACK_PEERS=1`). What the advertising side publishes is
  `core.net.advertised_address()` — the pinned `NEXTHMI_HOST`, else the routed
  address — so a runtime pinned to loopback
  advertises loopback and is rejected here by name, rather than luring peers
  to an address it never bound.
- The only unauthenticated peer surface is `GET /api/manager/peer/info`,
  which repeats what the mDNS record already advertises (runtimeId and
  hostname), and `POST /api/manager/peer/pair`, which takes the device-admin
  password. Every other transfer and discovery route requires either the
  manager session cookie (browser-initiated) or a peer bearer token.

## Operator workflow

From the manager dashboard's Projects page:

- **Transfer** (on a project row) — push that project to a peer.
- **Pull from peer** (page header) — fetch a project from a peer into this
  manager.

From the editor's top bar:

- **Transfer** — push the open project to a peer. Shown only where a manager
  serves the editor (`/editor/<slug>/`), and disabled until the project's
  edits are saved, because the archive is built from what is on disk.

All three open `PeerTransferModal` (`frontend/src/config/components/projects/ProjectsView/PeerTransferModal.tsx`),
which:

1. Takes a peer host, protocol and port (autocompleted from mDNS discovery +
   manually-added peers) and pairs in three steps, **Verify device → Sign
   in → Send**: the probe's device card and fingerprint with "It doesn’t
   match" / "It matches, continue"; then "<host> verified · certificate
   pinned", the password and "Remember this device". A pinned, remembered
   device goes straight to Send. A changed certificate stops at step 1 with
   "Forget pinned certificate and verify again"; a plain-HTTP peer shows how to
   turn HTTPS on, and the override behind "Isolated network without HTTPS?".
2. For pull, lists the peer's registered projects to pick a source from, and
   asks the operator to trust the source of any project with code, naming it
   (see the trust model above).
3. Detects the name clashes it can see against the destination's registered
   projects and, only when there is one, asks how to resolve it (see below);
   otherwise it asks for a destination folder and whether to start the project
   once installed.
4. Runs the transfer, polling `GET .../transfers/{id}` or `.../pulls/{id}`
   every 500 ms for phase/byte progress. Supports cancel, and on error hands
   the form back editable: an unchanged form retries under the same
   `transferId`, while any amended parameter — or a refusal only a fresh id can
   clear — starts a new transfer under one; the same id with different
   parameters is a `409`. A failure names the phase the backend was in when it
   failed (`failedPhase`), not the last one the poller happened to catch, and
   carries a cause: the peer's own error `detail` is forwarded (length-capped),
   and a transport failure is classified (`_transport_reason`: the connection
   timed out, could not be opened, or the request failed).

## Collision policies

`collisionPolicy` is `reject`, `copy` or `replace`, but the operator does not
pick one from a list. The modal detects a clash as the destination folder is
typed and only then offers the resolutions ("don't overwrite anything",
"install as a separate copy", "replace the existing project") with the
consequence of each. With no clash there is no
control at all and `reject` is sent.

What the modal detects is narrower than the rule below, deliberately: it can
only read the destination's *registered* projects, while the backend's folder
half is a filesystem test on `<defaultProjectsRoot>/<folder>`. A directory left
behind by a project removed without deleting its folder is invisible to it, and
a project registered outside the projects root is not a folder clash at all —
however suggestive its own folder name, an install can never land on it. Only
the manager that owns a project can say which of the two it is, so the peer
list carries `inProjectsRoot` per project and the pull direction derives the
same answer from the local path. The backend is the real guard: when it refuses
with "project id or folder already exists", the modal takes the refusal itself
as the missing evidence, treats that folder as occupied, and opens the same
resolutions.

- **`reject`** (default) — fails if the destination project id or folder
  already exists.
- **`copy`** — installs under a caller-supplied new project id; requires a
  free id and folder. An id-only clash therefore needs nothing else; a folder
  clash needs a different folder, which the modal pre-fills with the first
  free `<folder>-2`, `<folder>-3`… name.
- **`replace`** — requires explicit confirmation (`confirmReplace: true`), a
  registered **stopped** destination, and its exact existing target-root
  folder. The old folder is renamed to a sibling backup before install and
  restored automatically if the install or manifest write fails.

In every case the destination folder must be one direct child of the
manager's configured `defaultProjectsRoot` — no absolute or nested paths.
Only the transfer's own destination project may be started, and only when
explicitly requested; every other running project and process is untouched.

## Reliability

- **Staging** — the incoming archive is validated in a transfer-owned sibling
  directory bound by a no-follow directory handle before anything touches the
  real destination.
- **Atomic commit** — install is a native atomic no-replace directory rename
  (`renameatx_np` on macOS, `renameat2` on Linux) so a pre-existing directory
  at the destination can never be silently replaced.
- **Journaling** — both the sender and receiver persist their own durable
  journal (`.peer-transfer-sender.json`, `.peer-transfer-receipts.json`,
  `.peer-transfer-pull.json` — see [data-formats.md](../architecture/data-formats.md))
  keyed by `transferId`, recording phase and on-disk identity (device/inode)
  before every destructive rename.
- **Crash reconciliation** — on manager restart, `reconcile_transfer_journals()`
  inspects each active journal entry against on-disk state and resolves it to
  `interrupted_retryable`, `rolled_back_after_restart`, `complete`, or —
  only when the on-disk state can't be proven safe —
  `recovery_required` (permanent, admin-owned, never auto-cleared).
- **Idempotent retry** — the same `transferId` with the same request
  parameters and archive bytes (fingerprinted by SHA-256) always returns the
  same outcome rather than re-running the transfer; different parameters or
  archive bytes return `409`.
- **Cancellation** is cooperative: packing/streaming/unpacking check a
  cancellation flag between chunks, and a sender's cancel request awaits the
  receiver's own cancellation before force-cancelling a stalled local task.

### Windows

The commit guarantee is weaker on Windows: there is no handle-relative
atomic-no-replace rename equivalent, so the receiver checks the destination
is absent and then renames as two separate steps (`os.rename` is already
no-replace there). A local actor who can already write into the projects
root could place something at the destination in that window. Staging
cleanup is likewise path-based rather than handle-bound on Windows. Both are
accepted trusted-LAN risks on that platform only.

## Related code

- `backend/api/manager_peers_api.py` — every route (pairing, discovery,
  transfer, pull, tokens); the only peer-transfer surface in the backend.
- `backend/core/peer_tokens.py` — hashed, revocable bearer tokens issued to
  peers, and the remembered tokens held for them.
- `backend/core/peer_trust.py` — confirmed certificate pins, by address and
  runtimeId.
- `backend/core/peer_discovery.py` — mDNS advertise/browse, manager-owned; the
  persistent runtimeId.
- `frontend/src/config/store/projectsStore.ts` — `probePeer`, `pairPeer`,
  `listPeerProjects`, `beginPeerTransfer`/`beginPeerPull` and their
  `get*`/`cancel*` counterparts.
