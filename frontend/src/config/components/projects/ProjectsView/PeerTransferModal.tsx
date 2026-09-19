import { useEffect, useId, useMemo, useRef, useState } from 'react';
import Button from '@config/components/ui/Button';
import ModalShell from '@config/components/ui/ModalShell';
import Select from '@config/components/ui/Select';
import {
  describeError,
  type DiscoveredPeer,
  type PeerProject,
  type PeerScheme,
  useProjectsStore,
} from '@config/store/projectsStore';
import { basename } from '@shared/utils/paths';
import { randomUuid } from '@shared/utils/id';
import { explainFailure, phaseLabel } from './peerTransferMessages';
import {
  freeFolderName,
  sameParams,
  type CollisionPolicy,
  type TransferParams,
} from './peerTransferParams';
import './projectForm.css';

interface Props {
  direction: 'push' | 'pull';
  /** Push only: the local project being sent. */
  source?: { id: string; name: string };
  /** Pull only: local project ids currently running, so the "replace" picker
   * can disable them without this component depending on manager store. */
  runningLocalProjectIds?: ReadonlySet<string>;
  onClose(): void;
  onTransferred(): void;
}

interface TransferStatus {
  transferId: string;
  phase: string;
  /** The phase that was running when it failed; `phase` holds the outcome. */
  failedPhase?: string | null;
  status:
    'active' | 'complete' | 'error' | 'cancelled' | 'applied_pending_start' | 'recovery_required';
  bytesDone: number;
  bytesTotal: number;
  message?: string | null;
}

/** A project already registered on whichever side receives this transfer. */
interface TargetProject {
  id: string;
  name: string;
  folder: string;
  running: boolean;
  /**
   * Whether `folder` is this project's folder *inside the target's projects
   * root*. A transfer may only ever install into that root, so a project
   * registered elsewhere on disk can neither collide with nor be replaced by
   * one — however suggestive its own folder name is.
   */
  inProjectsRoot: boolean;
}

type ClashKind = 'none' | 'id' | 'folder' | 'both';

interface Clash {
  kind: ClashKind;
  byId?: TargetProject;
  byFolder?: TargetProject;
}

const RESOLUTIONS: ReadonlyArray<{ value: CollisionPolicy; label: string }> = [
  { value: 'reject', label: 'Don’t overwrite anything' },
  { value: 'copy', label: 'Install as a separate copy' },
  { value: 'replace', label: 'Replace the existing project' },
];

export default function PeerTransferModal({
  direction,
  source,
  runningLocalProjectIds,
  onClose,
  onTransferred,
}: Props) {
  const isPull = direction === 'pull';

  const pairPeer = useProjectsStore((state) => state.pairPeer);
  const listPeerProjects = useProjectsStore((state) => state.listPeerProjects);
  const beginPeerTransfer = useProjectsStore((state) => state.beginPeerTransfer);
  const beginPeerPull = useProjectsStore((state) => state.beginPeerPull);
  const getPeerTransfer = useProjectsStore((state) => state.getPeerTransfer);
  const getPeerPull = useProjectsStore((state) => state.getPeerPull);
  const cancelPeerTransfer = useProjectsStore((state) => state.cancelPeerTransfer);
  const cancelPeerPull = useProjectsStore((state) => state.cancelPeerPull);
  const loadPeers = useProjectsStore((state) => state.loadPeers);
  const forgetPeerCertificate = useProjectsStore((state) => state.forgetPeerCertificate);
  const localProjects = useProjectsStore((state) => state.projects);

  const [host, setHost] = useState('');
  const [port, setPort] = useState(8000);
  const [scheme, setScheme] = useState<PeerScheme>('http');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [remoteProjects, setRemoteProjects] = useState<PeerProject[]>([]);
  const [peerSuggestions, setPeerSuggestions] = useState<DiscoveredPeer[]>([]);
  const [policy, setPolicy] = useState<CollisionPolicy>('reject');
  const [pullSourceId, setPullSourceId] = useState('');
  const [destinationFolder, setDestinationFolder] = useState(source?.name ?? '');
  const [replacementId, setReplacementId] = useState('');
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [start, setStart] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A refusal never names the folder it tripped over, and the field may have
  // moved on by the time it arrives — so the attempt's own folder is kept and
  // paired with the refusal that follows it.
  const [attemptedFolder, setAttemptedFolder] = useState<string | null>(null);
  const [refusedFolder, setRefusedFolder] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<TransferStatus | null>(null);
  const [lastActivePhase, setLastActivePhase] = useState<string | null>(null);
  const [transferId, setTransferId] = useState(() => `${isPull ? 'pull' : 'tx'}-${randomUuid()}`);
  const [copyDestinationId, setCopyDestinationId] = useState(() => randomUuid());
  const [startedParams, setStartedParams] = useState<TransferParams | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const resolutionName = useId();

  const pullSource = useMemo(
    () => remoteProjects.find((project) => project.id === pullSourceId),
    [remoteProjects, pullSourceId],
  );

  // Push installs onto the peer (from `remoteProjects`); pull installs onto
  // this manager (from the local store) — same clash rules and same replace
  // picker, different backing list. Either side may hold a project registered
  // outside its projects root, whose folder name can neither clash with an
  // install nor be replaced by one. Only the owning manager can tell: the peer
  // reports it, and for a local project the path decides.
  const targets = useMemo<TargetProject[]>(
    () =>
      isPull
        ? localProjects.map((project) => ({
            id: project.id,
            name: project.name,
            folder: basename(project.path),
            running: runningLocalProjectIds?.has(project.id) ?? false,
            inProjectsRoot: project.inProjectsRoot,
          }))
        : remoteProjects.map((project) => ({
            ...project,
            inProjectsRoot: project.inProjectsRoot ?? true,
          })),
    [isPull, localProjects, remoteProjects, runningLocalProjectIds],
  );
  // A folder the backend refused is occupied by something the registry cannot
  // see — a directory no project claims — so it counts as taken even when the
  // clash the modal found was an id clash, or no clash at all.
  const takenFolders = useMemo(
    () =>
      new Set([
        ...targets.filter((target) => target.inProjectsRoot).map((target) => target.folder),
        ...(refusedFolder ? [refusedFolder] : []),
      ]),
    [refusedFolder, targets],
  );

  const selectedReplacement = useMemo(
    () => targets.find((target) => target.id === replacementId),
    [targets, replacementId],
  );
  const selectedReplacementFolder = selectedReplacement?.folder;
  const sourceProjectId = isPull ? pullSourceId : (source?.id ?? '');
  const trimmedFolder = destinationFolder.trim();
  const currentParams: TransferParams = {
    sourceProjectId,
    destinationFolder: trimmedFolder,
    collisionPolicy: policy,
    replacementId,
    confirmReplace,
    start,
  };

  // As much of the backend's reject rule (`begin_pull` / `receive`) as the
  // modal can see: a registered project carrying the source's id, or one
  // registered in the destination folder. The backend's folder half is a
  // filesystem test, so a directory left behind by a delete-without-folder is
  // invisible here — `collisionRefused` below picks that case up from the
  // refusal itself. The backend stays the real guard either way.
  const clash = useMemo<Clash>(() => {
    const folder = destinationFolder.trim();
    const byId = sourceProjectId
      ? targets.find((target) => target.id === sourceProjectId)
      : undefined;
    const byFolder = folder
      ? targets.find((target) => target.inProjectsRoot && target.folder === folder)
      : undefined;
    if (byId && byFolder) return { kind: 'both', byId, byFolder };
    if (byId) return { kind: 'id', byId };
    if (byFolder) return { kind: 'folder', byFolder };
    return { kind: 'none' };
  }, [destinationFolder, sourceProjectId, targets]);

  useEffect(() => {
    void loadPeers()
      .then((peers) => {
        if (!peers) return;
        // A peer manually added and then found over mDNS appears in both
        // lists. Keyed by the address the option list is keyed by, first one
        // wins — so the live discovered record beats a stale manual entry, and
        // the host list offers each peer once.
        const byAddress = new Map<string, DiscoveredPeer>();
        for (const peer of [...peers.discovered, ...peers.manual]) {
          const key = `${peer.host}:${peer.port}`;
          if (!byAddress.has(key)) byAddress.set(key, peer);
        }
        setPeerSuggestions([...byAddress.values()]);
      })
      .catch(() => setPeerSuggestions([]));
  }, [loadPeers]);

  useEffect(() => {
    if (policy === 'replace' && selectedReplacementFolder) {
      setDestinationFolder(selectedReplacementFolder);
    }
  }, [policy, selectedReplacementFolder]);

  useEffect(() => {
    if (isPull && policy !== 'replace' && pullSource) {
      setDestinationFolder((current) => current || pullSource.folder);
    }
  }, [isPull, policy, pullSource]);

  // A separate copy needs a folder of its own. Choosing "separate copy" moves
  // off an occupied folder; a refusal landing while it is *already* chosen
  // has to move off it too, and nothing clicks to make that happen. Keyed on
  // the refused name rather than a flag so a suggestion that already moved is
  // left alone — `takenFolders` is rebuilt on every running-set poll, and
  // re-bumping would walk the name one further every three seconds.
  useEffect(() => {
    if (!refusedFolder || policy !== 'copy') return;
    setDestinationFolder((current) =>
      current.trim() === refusedFolder ? freeFolderName(refusedFolder, takenFolders) : current,
    );
  }, [policy, refusedFolder, takenFolders]);

  useEffect(() => {
    if (transfer?.status === 'active') setLastActivePhase(transfer.phase);
  }, [transfer]);

  useEffect(() => {
    if (!transfer || transfer.status !== 'active') return;
    const getStatus = isPull ? getPeerPull : getPeerTransfer;
    const timer = window.setInterval(() => {
      void getStatus(transfer.transferId)
        .then((next) => {
          setTransfer(next);
          if (next.status === 'complete') onTransferred();
        })
        .catch((reason) => setError(describeError(reason)));
    }, 500);
    return () => window.clearInterval(timer);
  }, [getPeerPull, getPeerTransfer, isPull, onTransferred, transfer]);

  const paired = token.length > 0;
  // A pin mismatch mid-transfer surfaces on the transfer's own `message`
  // (set by the poller from a 200 response), not on `error` (set only when
  // the request that fetches status itself fails) — check both so the
  // recovery action shows up wherever the operator actually sees the text.
  const certificateChanged =
    (!!error && error.includes('Certificate for peer')) ||
    (!!transfer?.message && transfer.message.includes('Certificate for peer'));
  const failureText = error ?? (transfer?.status === 'error' ? (transfer.message ?? null) : null);

  // The backend's folder check is a filesystem test `clash` cannot make, so
  // its refusal is the only evidence that something is in the way. Without
  // this the refusal is a dead end: no clash to show, and therefore no
  // resolution to pick.
  useEffect(() => {
    if (failureText?.includes('project id or folder already exists')) {
      setRefusedFolder(attemptedFolder);
    }
  }, [attemptedFolder, failureText]);

  const collisionRefused = refusedFolder !== null;
  const showResolution = clash.kind !== 'none' || policy !== 'reject' || collisionRefused;
  const failure = failureText ? explainFailure(failureText, showResolution) : null;
  // A source archive that no longer matches the first attempt can never
  // succeed under the same id, however many times the retry is pressed.
  const mustRestart = !!failureText?.includes('use a new id');

  // Picking a discovered/manual peer carries its port and protocol with it —
  // typing the host of an HTTPS peer and leaving the protocol on HTTP would
  // otherwise fail at the handshake with nothing pointing at why.
  function onHostChange(next: string) {
    setHost(next);
    const known = peerSuggestions.find((peer) => peer.host === next.trim());
    if (!known) return;
    setPort(known.port);
    setScheme(known.scheme);
  }

  async function pair() {
    setBusy(true);
    setError(null);
    try {
      // The bearer token can install and replace projects on the remote
      // manager, so it stays in component state for this modal's lifetime —
      // never in web storage, where any script on this origin could read it.
      const paired = await pairPeer(host.trim(), port, password, scheme);
      setToken(paired.token);
      setFingerprint(paired.certificateFingerprint ?? null);
      setPassword('');
      const projects = await listPeerProjects(host.trim(), port, paired.token, scheme);
      setRemoteProjects(projects);
    } catch (reason) {
      const text = describeError(reason);
      setError(text);
      // A mistyped password is the common failure: leave it in the field and
      // put the caret back in it rather than making it be retyped blind.
      if (text.includes('Incorrect device-admin password')) passwordRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  async function forgetCertificate() {
    setBusy(true);
    try {
      await forgetPeerCertificate(host.trim(), port);
      setError(null);
      // `transfer.message` still holds the mismatch this button was offered
      // for; leaving it set would keep both the failure panel and this
      // button on screen until the next submit overwrites it.
      setTransfer(null);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  }

  function editDestinationFolder(next: string) {
    setDestinationFolder(next);
    // A fresh name starts clean: the refusal that forced the choices open was
    // about the name being replaced.
    setRefusedFolder(null);
  }

  function chooseResolution(next: CollisionPolicy) {
    setPolicy(next);
    if (next !== 'copy') return;
    const folder = destinationFolder.trim();
    if (takenFolders.has(folder)) setDestinationFolder(freeFolderName(folder, takenFolders));
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const params = currentParams;
      // The backend fingerprints every parameter except the id and the token,
      // so an amended retry under the same id is refused with a 409. Unchanged
      // parameters keep the id and resume idempotently; anything else is a new
      // transfer, and a copy needs a destination id that is free too.
      const amended = mustRestart || (startedParams !== null && !sameParams(params, startedParams));
      const nextTransferId = amended ? `${isPull ? 'pull' : 'tx'}-${randomUuid()}` : transferId;
      const nextCopyId = amended && policy === 'copy' ? randomUuid() : copyDestinationId;
      const destinationProjectId =
        policy === 'copy' ? nextCopyId : policy === 'replace' ? replacementId : sourceProjectId;
      const begin = isPull ? beginPeerPull : beginPeerTransfer;
      // Recorded before the call: a pull is refused by the response itself, a
      // push only later by a polled status, and both have to name this folder.
      setAttemptedFolder(params.destinationFolder);
      const next = await begin({
        sourceProjectId,
        destinationProjectId,
        destinationFolder: params.destinationFolder,
        peerHost: host.trim(),
        peerPort: port,
        peerScheme: scheme,
        token,
        collisionPolicy: policy,
        confirmReplace,
        start,
        transferId: nextTransferId,
      });
      setTransferId(nextTransferId);
      setCopyDestinationId(nextCopyId);
      setStartedParams(params);
      setLastActivePhase(null);
      setRefusedFolder(null);
      setTransfer(next);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  }

  const transferActive = transfer?.status === 'active';
  // A failed or cancelled transfer hands the form back so the resolution can
  // be amended in place; only a completed one is done with it.
  const showForm = paired && !transferActive && transfer?.status !== 'complete';

  // Replacement installs into the existing project's own folder, and that
  // folder has to be one in the target's projects root — a project registered
  // anywhere else is one the backend refuses every time.
  const replaceable = useMemo(() => targets.filter((target) => target.inProjectsRoot), [targets]);
  const eligibleReplacements = useMemo(
    () => replaceable.filter((target) => !target.running),
    [replaceable],
  );
  const canTransfer =
    paired &&
    (!isPull || pullSourceId.length > 0) &&
    destinationFolder.trim().length > 0 &&
    (policy !== 'replace' || (replacementId.length > 0 && confirmReplace)) &&
    !busy &&
    !transferActive;
  const pct = transfer?.bytesTotal
    ? Math.min(100, Math.round((transfer.bytesDone / transfer.bytesTotal) * 100))
    : 0;

  const replaceLabel = isPull ? 'local project' : 'destination project';
  const replacePickerLabel = isPull ? 'Local project to replace' : 'Destination project';
  const peerLabel = isPull ? 'This manager' : host.trim() || 'The peer';
  const peerLabelInline = isPull ? 'this manager' : host.trim() || 'the peer';

  // Only rendered for a clash the modal can actually name. Picking "separate
  // copy" frees the folder and empties the clash while the choices stay open,
  // and a refusal the modal never saw coming has nothing to summarise either.
  const clashSummary =
    clash.kind === 'both'
      ? `${peerLabel} already has "${clash.byId?.name}" under the same project ID, and "${clash.byFolder?.name}" in the folder "${trimmedFolder}".`
      : clash.kind === 'id'
        ? `${peerLabel} already has "${clash.byId?.name}" under the same project ID.`
        : clash.kind === 'folder'
          ? `${peerLabel} already has "${clash.byFolder?.name}" in the folder "${trimmedFolder}".`
          : null;
  const resolveHeading =
    clash.kind === 'none' && !collisionRefused
      ? 'Choose how to install'
      : 'Something is already there';

  const copyNeedsFolder = clash.kind === 'folder' || clash.kind === 'both' || collisionRefused;
  const noReplaceTarget = eligibleReplacements.length === 0;

  function resolutionDetail(value: CollisionPolicy): string {
    if (value === 'reject') {
      return `The transfer stops instead of touching anything on ${peerLabelInline}.`;
    }
    if (value === 'copy') {
      return copyNeedsFolder
        ? 'Installs beside the existing project, under a new project ID and its own folder.'
        : 'Installs beside the existing project, under a new project ID.';
    }
    return 'Backs up the existing project and installs over it. It has to be stopped first.';
  }

  const submitLabel = !transfer
    ? isPull
      ? 'Pull'
      : 'Transfer'
    : mustRestart || (startedParams !== null && !sameParams(currentParams, startedParams))
      ? 'Start a new transfer'
      : 'Retry';

  const progressHeadline = (() => {
    if (!transfer) return '';
    const label = phaseLabel(transfer.phase);
    // Only an outcome that stopped somewhere needs the step it stopped in;
    // every other terminal phase already names itself.
    if (transfer.status !== 'error' && transfer.status !== 'cancelled') return label;
    // The backend reports the phase it was actually in. `lastActivePhase` is a
    // client-side guess that a transfer dying before the first poll leaves
    // pointing at whatever the begin response happened to say.
    const where = transfer.failedPhase ?? lastActivePhase;
    return where && where !== transfer.phase
      ? `${label} while ${phaseLabel(where).toLowerCase()}`
      : label;
  })();

  const folderField = (
    <label className="project-form__field">
      <span className="project-form__label">
        {isPull ? 'Local destination folder' : 'Destination folder'} under target root
      </span>
      <input
        className="cfg-prop-input cfg-prop-input--tall"
        value={destinationFolder}
        onChange={(event) => editDestinationFolder(event.target.value)}
      />
      <span className="project-form__hint">A folder name only; absolute paths are rejected.</span>
    </label>
  );

  return (
    <ModalShell onClose={onClose} dialogClassName="name-modal cfg-flex-col">
      <div className="name-modal__title">
        {isPull ? 'Pull a project from a peer' : `Transfer "${source?.name}" to a peer`}
      </div>
      <p className="project-form__desc">
        {scheme === 'https'
          ? 'The peer’s certificate is pinned the first time it is seen, and required to match on every later transfer.'
          : 'This authenticated transfer uses plain HTTP. Use it only on a trusted LAN where traffic interception is an accepted risk.'}
      </p>

      <div className="project-form__row">
        <label className="project-form__field">
          <span className="project-form__label">{isPull ? 'Source host' : 'Destination host'}</span>
          <input
            className="cfg-prop-input cfg-prop-input--tall"
            value={host}
            list="manager-peer-hosts"
            disabled={paired || !!transfer}
            onChange={(event) => onHostChange(event.target.value)}
            placeholder="192.168.1.20"
          />
          <datalist id="manager-peer-hosts">
            {peerSuggestions.map((peer) => (
              <option key={`${peer.host}:${peer.port}`} value={peer.host}>
                {peer.scheme}://{peer.host}:{peer.port}
              </option>
            ))}
          </datalist>
        </label>
        <div className="project-form__field">
          <span className="project-form__label">Protocol</span>
          <Select
            aria-label="Protocol"
            value={scheme}
            disabled={paired || !!transfer}
            onChange={(value) => setScheme(value as PeerScheme)}
          >
            <option value="http">HTTP</option>
            <option value="https">HTTPS</option>
          </Select>
        </div>
        <label className="project-form__field">
          <span className="project-form__label">Port</span>
          <input
            className="cfg-prop-input cfg-prop-input--tall"
            type="number"
            min={1}
            max={65535}
            value={port}
            disabled={paired || !!transfer}
            onChange={(event) => setPort(Number(event.target.value))}
          />
        </label>
      </div>

      {!paired && (
        <>
          <label className="project-form__field">
            <span className="project-form__label">
              {isPull ? 'Source' : 'Destination'} device-admin password
            </span>
            <input
              ref={passwordRef}
              className="cfg-prop-input cfg-prop-input--tall"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <span className="project-form__hint">
              Used once for pairing and never stored. The peer stores only a revocable token hash.
            </span>
          </label>
          <Button
            variant="primary"
            onClick={() => void pair()}
            disabled={busy || !host.trim() || !password}
          >
            {busy ? 'Pairing…' : 'Pair & continue'}
          </Button>
        </>
      )}

      {fingerprint && (
        <p className="project-form__hint">
          Pinned certificate SHA-256: <code>{fingerprint}</code>
        </p>
      )}

      {transfer && (
        <div className="project-form__field">
          <span className="project-form__label">{progressHeadline}</span>
          <progress value={pct} max={100} />
          {/* A journal-owned outcome — an install waiting to be started, one
              needing recovery — carries its explanation here and nowhere
              else; only `error` reaches the failure panel below. */}
          {transfer.status !== 'active' && transfer.status !== 'error' && transfer.message && (
            <p className="project-form__hint">{transfer.message}</p>
          )}
          {transferActive && (
            <Button
              variant="ghost"
              onClick={() =>
                void (isPull ? cancelPeerPull : cancelPeerTransfer)(transfer.transferId)
                  .then(setTransfer)
                  .catch((reason) => setError(describeError(reason)))
              }
            >
              Cancel transfer
            </Button>
          )}
        </div>
      )}

      {failure && (
        <div className="project-form__failure">
          <p className="project-form__status project-form__status--error">{failure.cause}</p>
          {failure.action && <p className="project-form__hint">{failure.action}</p>}
        </div>
      )}
      {certificateChanged && (
        <Button variant="ghost" disabled={busy} onClick={() => void forgetCertificate()}>
          Forget pinned certificate and retry
        </Button>
      )}

      {showForm && (
        <>
          {isPull && (
            <div className="project-form__field">
              <span className="project-form__label">Source project on peer</span>
              <Select
                aria-label="Source project on peer"
                value={pullSourceId}
                onChange={setPullSourceId}
              >
                <option value="">Select a project…</option>
                {remoteProjects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name} ({project.folder})
                  </option>
                ))}
              </Select>
            </div>
          )}
          {policy === 'reject' && folderField}
          {!showResolution && trimmedFolder.length > 0 && (
            <p className="project-form__hint">
              {`${peerLabel} has no project or folder named "${trimmedFolder}".`}
            </p>
          )}
          {showResolution && (
            <div className="project-form__resolve">
              <span className="project-form__label">{resolveHeading}</span>
              {clashSummary && <p className="project-form__hint">{clashSummary}</p>}
              <div className="project-form__choices">
                {RESOLUTIONS.map((resolution) => (
                  <div
                    key={resolution.value}
                    className={`project-form__choice${
                      policy === resolution.value ? ' project-form__choice--active' : ''
                    }`}
                  >
                    <label className="project-form__choice-head">
                      <input
                        type="radio"
                        name={resolutionName}
                        value={resolution.value}
                        checked={policy === resolution.value}
                        onChange={() => chooseResolution(resolution.value)}
                      />
                      <span>{resolution.label}</span>
                    </label>
                    <p className="project-form__choice-detail">
                      {resolutionDetail(resolution.value)}
                    </p>
                    {policy === 'copy' && resolution.value === 'copy' && (
                      <div className="project-form__choice-extra">{folderField}</div>
                    )}
                    {policy === 'replace' && resolution.value === 'replace' && (
                      <div className="project-form__choice-extra">
                        {noReplaceTarget ? (
                          <p className="project-form__hint">
                            {replaceable.length === 0
                              ? `${peerLabel} has no project in its projects root to replace.`
                              : `Every project on ${peerLabelInline} is running. Stop the one to replace first.`}
                          </p>
                        ) : (
                          <>
                            <div className="project-form__field">
                              <span className="project-form__label">{replacePickerLabel}</span>
                              <Select
                                aria-label={replacePickerLabel}
                                value={replacementId}
                                onChange={setReplacementId}
                              >
                                <option value="">Select a stopped {replaceLabel}…</option>
                                {replaceable.map((target) => (
                                  <option
                                    key={target.id}
                                    value={target.id}
                                    disabled={target.running}
                                  >
                                    {target.name} ({target.folder})
                                    {target.running ? ' — running' : ''}
                                  </option>
                                ))}
                              </Select>
                            </div>
                            <label className="project-form__toggle">
                              <input
                                type="checkbox"
                                checked={confirmReplace}
                                onChange={(event) => setConfirmReplace(event.target.checked)}
                              />
                              <span>Back up and replace this stopped {replaceLabel}</span>
                            </label>
                            {selectedReplacementFolder && (
                              <span className="project-form__hint">
                                {`Installs into "${selectedReplacementFolder}", the folder that project is registered under.`}
                              </span>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          <label className="project-form__toggle">
            <input
              type="checkbox"
              checked={start}
              onChange={(event) => setStart(event.target.checked)}
            />
            <span>Start the {isPull ? 'local' : 'destination'} project after transfer</span>
          </label>
        </>
      )}

      <div className="name-modal__actions">
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        {showForm && (
          <Button variant="primary" disabled={!canTransfer} onClick={() => void submit()}>
            {submitLabel}
          </Button>
        )}
      </div>
    </ModalShell>
  );
}
