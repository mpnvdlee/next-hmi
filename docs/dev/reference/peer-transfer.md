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
  or, when the operator ticks **Remember this device** (off by default), on the
  initiating manager in `<runtime_home>/.peer-pairings.json` (`0600`, written
  through `write_text_atomic`), keyed by the peer's runtimeId and bound to the
  certificate it was paired over. A remembered token is only sent over a
  handshake anchored on that certificate (`peer_tokens.remembered`), so the
  next transfer to the device needs no password. Plain-HTTP pairings are never
  remembered. Forgetting a device's pins (`DELETE /api/manager/peers/trust`)
  also drops the token remembered for its runtimeId — the pin's, and the one
  the request names.
- **Tokens** expire after 90 days without use: a peer request with an expired
  one is refused and the token pruned. Use is recorded in memory on every
  request and written to `.peer-tokens.json` at most once an hour per token.
  The pairing request carries the requesting device's own hostname and
  runtimeId (claims, shown and trusted for nothing) and the destination records
  the address it came from; **Settings › Tokens** lists every pairing under
  **Paired devices** (device, paired, last used, expires — the warning colour
  within 14 days) with **Revoke**
  (`GET`/`DELETE /api/manager/peer-tokens`, device-admin session only). All of
  them are revoked when the device-admin password changes (`authGeneration`
  pinning in `core/peer_tokens.py`). A device whose token is refused — revoked,
  expired, or from an earlier password — is told so with
  `code: "peer_pairing_refused"`; the modal then shows "*host* no longer
  accepts this device" and **Pair again**, which drops the key remembered for
  it (`DELETE /api/manager/peer-pairings/{runtimeId}`, the pin stays) and
  returns to Sign in.
- **A transfer belongs to its pairing.** The destination's receipt records the
  token that created it; its status, its cancel and a retry under its
  `transferId` answer that token only (another one gets `404`, or `409` for a
  retry). What a peer token reads carries no absolute path of the destination:
  `targetPath`, `containerPath`, `backupPath` and the on-disk identities stay in
  the receipt for the device-admin, and the projects root is cut from any
  message that quotes a path.
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
- **Pins from before confirmation** — earlier releases pinned silently on
  first contact and wrote no `runtimeId` key. Such a pin (`Pin.confirmed` is
  false) still anchors the connection and still makes a different certificate
  read as `changed`, but it never counts as confirmed: the probe reports
  `trust: "new"` with the fingerprint to compare, and the pairing that follows
  re-saves it with the runtimeId. A pin saved by this release always carries
  the key, `null` for a peer too old to report one.
- **A cloned identity** — a runtime home copied to another machine carries
  `.peer-identity.json`, so two devices share a runtimeId: discovery hides
  them from each other and a pin between them would read as changed. A probe
  or pairing whose peer answers with this manager's own runtimeId is refused
  with a `409` "This device has the same identity as the one you are pairing
  with. Delete .peer-identity.json in one of their runtime homes and restart
  it." instead.
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
- **What a peer sends back is bounded.** Every JSON reply is read through a
  4 MB cap and refused above it (an error body is cut to 64 KB); a pull stops
  as soon as the archive passes `max_zip_bytes()` (`NEXTHMI_MAX_PROJECT_ZIP_MB`,
  the limit a push receiver applies) — at once when `Content-Length` says so —
  and when the whole download outlasts 11 minutes, and the partial archive is
  deleted either way. mDNS announcements are bounded too: see
  [backend.md](../architecture/backend.md#main-modules).
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

1. Takes a peer host, protocol and port (HTTPS on 8443 to start with;
   autocompleted from mDNS discovery + manually-added peers, which bring their
   own) and pairs in three steps, **Verify device → Sign in → Send** (**Fetch**
   for a pull), in a dialog of one fixed width: the probe's device card and
   fingerprint (four-character groups on two lines) with "It doesn’t match" /
   "It matches, continue"; then "<host> verified", the password and "Remember
   this device" (unticked). The pin is saved at Sign in. A pinned, remembered
   device goes straight to the last step, unless it refuses the remembered key
   (see **Tokens** above). A changed certificate stops at step 1
   with "Forget pinned certificate and verify again"; a plain-HTTP peer shows
   how to turn HTTPS on, and the override behind "Isolated network without
   HTTPS?" — once ticked, the refusal gives way to "Unencrypted connection: the
   certificate cannot be verified." and step 1 reads "Not verified (HTTP)"
   rather than done.
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
  already exists. Ids are compared ignoring case when the manifest commit
  registers the install (`core.manifest.save_manifest`): `LINE3` beside a
  registered `line3` is refused and rolled back, with the same "project id or
  folder already exists" wording, since on Windows and macOS the two share
  their folders under the runtime home.
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
