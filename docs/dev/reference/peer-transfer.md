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

- **Pairing** — the initiator authenticates once with the *destination's*
  existing device-admin password (`POST /pair`). The destination returns a
  random bearer token and persists only its SHA-256 digest; the plaintext
  token is shown once and lives only in the transfer modal's component state
  (never web storage).
- **Tokens** are individually revocable (Settings → peer tokens) and are all
  revoked automatically when the device-admin password changes
  (`authGeneration` pinning in `core/peer_tokens.py`).
- **Transport** is plain HTTP, accepted only as an explicit trusted-LAN risk —
  bearer auth stops unauthenticated mutation but does not encrypt the pairing
  password, token, or archive in transit. Deployments needing confidentiality
  need a private network or TLS termination in front.
- **Address pinning** — outgoing connections resolve the peer hostname once
  and pin the HTTP connection to that private unicast address. Public, mixed
  public/private, link-local, multicast, and unspecified answers are
  rejected; loopback requires an explicit deployment override
  (`NEXTHMI_ALLOW_LOOPBACK_PEERS=1`).
- There is no unauthenticated peer surface anywhere in the backend — every
  transfer, discovery, and pairing route requires either the manager session
  cookie (browser-initiated) or a peer bearer token.

## Operator workflow

From the manager dashboard's Projects page:

- **Transfer** (on a project row) — push that project to a peer.
- **Pull from peer** (page header) — fetch a project from a peer into this
  manager.

Both open `PeerTransferModal` (`frontend/src/config/components/projects/ProjectsView/PeerTransferModal.tsx`),
which:

1. Takes a peer host/port (autocompleted from mDNS discovery + manually-added
   peers) and pairs.
2. For pull, lists the peer's registered projects to pick a source from.
3. Picks a **collision policy** (see below), a destination folder or
   replacement target, and whether to start the project once installed.
4. Runs the transfer, polling `GET .../transfers/{id}` or `.../pulls/{id}`
   every 500 ms for phase/byte progress. Supports cancel and same-ID retry
   on error.

## Collision policies

- **`reject`** (default) — fails if the destination project id or folder
  already exists.
- **`copy`** — installs under a caller-supplied new project id; requires a
  free id and folder.
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
- `backend/core/peer_tokens.py` — hashed, revocable bearer tokens.
- `backend/core/peer_discovery.py` — mDNS advertise/browse, manager-owned.
- `frontend/src/config/store/projectsStore.ts` — `pairPeer`, `listPeerProjects`,
  `beginPeerTransfer`/`beginPeerPull` and their `get*`/`cancel*` counterparts.
