import { useEffect, useMemo, useState } from 'react';
import Button from '@config/components/ui/Button';
import ModalShell from '@config/components/ui/ModalShell';
import Select from '@config/components/ui/Select';
import {
  describeError,
  type DiscoveredPeer,
  type PeerScheme,
  type ProjectEntry,
  useProjectsStore,
} from '@config/store/projectsStore';
import { basename } from '@shared/utils/paths';

interface Props {
  direction: 'push' | 'pull';
  /** Push only: the local project being sent. */
  source?: ProjectEntry;
  /** Pull only: local project ids currently running, so the "replace" picker
   * can disable them without this component depending on manager store. */
  runningLocalProjectIds?: ReadonlySet<string>;
  onClose(): void;
  onTransferred(): void;
}

type CollisionPolicy = 'reject' | 'replace' | 'copy';

interface RemoteProject {
  id: string;
  name: string;
  folder: string;
  running: boolean;
}

interface TransferStatus {
  transferId: string;
  phase: string;
  status: 'active' | 'complete' | 'error' | 'cancelled';
  bytesDone: number;
  bytesTotal: number;
  message?: string | null;
}

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
  const [remoteProjects, setRemoteProjects] = useState<RemoteProject[]>([]);
  const [peerSuggestions, setPeerSuggestions] = useState<DiscoveredPeer[]>([]);
  const [policy, setPolicy] = useState<CollisionPolicy>('reject');
  const [pullSourceId, setPullSourceId] = useState('');
  const [destinationFolder, setDestinationFolder] = useState(source?.name ?? '');
  const [replacementId, setReplacementId] = useState('');
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [start, setStart] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<TransferStatus | null>(null);
  const [transferId] = useState(() => `${isPull ? 'pull' : 'tx'}-${window.crypto.randomUUID()}`);
  const [copyDestinationId] = useState(() => window.crypto.randomUUID());

  const pullSource = useMemo(
    () => remoteProjects.find((project) => project.id === pullSourceId),
    [remoteProjects, pullSourceId],
  );

  // Push replaces a project on the peer (from `remoteProjects`); pull replaces
  // a project on this manager (from the local store) — same picker shape,
  // different backing list.
  const selectedReplacement = useMemo(
    () =>
      isPull
        ? localProjects.find((project) => project.id === replacementId)
        : remoteProjects.find((project) => project.id === replacementId),
    [isPull, localProjects, remoteProjects, replacementId],
  );
  const selectedReplacementFolder = useMemo(() => {
    if (!selectedReplacement) return undefined;
    return isPull
      ? basename((selectedReplacement as ProjectEntry).path)
      : (selectedReplacement as RemoteProject).folder;
  }, [isPull, selectedReplacement]);

  useEffect(() => {
    void loadPeers()
      .then((peers) => {
        if (peers) setPeerSuggestions([...peers.discovered, ...peers.manual]);
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
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  }

  async function forgetCertificate() {
    setBusy(true);
    try {
      await forgetPeerCertificate(host.trim(), port);
      setError(null);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const sourceProjectId = isPull ? pullSourceId : (source as ProjectEntry).id;
      const destinationProjectId =
        policy === 'copy'
          ? copyDestinationId
          : policy === 'replace'
            ? replacementId
            : sourceProjectId;
      const begin = isPull ? beginPeerPull : beginPeerTransfer;
      const next = await begin({
        sourceProjectId,
        destinationProjectId,
        destinationFolder: destinationFolder.trim(),
        peerHost: host.trim(),
        peerPort: port,
        peerScheme: scheme,
        token,
        collisionPolicy: policy,
        confirmReplace,
        start,
        transferId,
      });
      setTransfer(next);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  }

  const paired = token.length > 0;
  // A pin mismatch mid-transfer surfaces on the transfer's own `message`
  // (set by the poller from a 200 response), not on `error` (set only when
  // the request that fetches status itself fails) — check both so the
  // recovery action shows up wherever the operator actually sees the text.
  const certificateChanged =
    (!!error && error.includes('Certificate for peer')) ||
    (!!transfer?.message && transfer.message.includes('Certificate for peer'));
  const canTransfer =
    paired &&
    (!isPull || pullSourceId.length > 0) &&
    destinationFolder.trim().length > 0 &&
    (policy !== 'replace' || (replacementId.length > 0 && confirmReplace)) &&
    !busy &&
    transfer?.status !== 'active';
  const pct = transfer?.bytesTotal
    ? Math.min(100, Math.round((transfer.bytesDone / transfer.bytesTotal) * 100))
    : 0;

  const replaceLabel = isPull ? 'local project' : 'destination project';

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

      {paired && !transfer && (
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
          <div className="project-form__field">
            <span className="project-form__label">Collision handling</span>
            <Select
              aria-label="Collision handling"
              value={policy}
              onChange={(value) => setPolicy(value as CollisionPolicy)}
            >
              <option value="reject">Reject any collision</option>
              <option value="copy">Copy with a new project ID</option>
              <option value="replace">Replace a stopped project</option>
            </Select>
          </div>
          {policy === 'replace' ? (
            <>
              <div className="project-form__field">
                <span className="project-form__label">
                  {isPull ? 'Local project to replace' : 'Destination project'}
                </span>
                <Select
                  aria-label={isPull ? 'Local project to replace' : 'Destination project'}
                  value={replacementId}
                  onChange={setReplacementId}
                >
                  <option value="">Select a stopped {replaceLabel}…</option>
                  {(isPull ? localProjects : remoteProjects).map((project) => {
                    const running = isPull
                      ? (runningLocalProjectIds?.has(project.id) ?? false)
                      : (project as RemoteProject).running;
                    const folder = isPull
                      ? basename((project as ProjectEntry).path)
                      : (project as RemoteProject).folder;
                    return (
                      <option key={project.id} value={project.id} disabled={running}>
                        {project.name} ({folder}){running ? ' — running' : ''}
                      </option>
                    );
                  })}
                </Select>
              </div>
              <label className="mgr-mcp-toggle">
                <input
                  type="checkbox"
                  checked={confirmReplace}
                  onChange={(event) => setConfirmReplace(event.target.checked)}
                />
                <span>Back up and replace this stopped {replaceLabel}</span>
              </label>
            </>
          ) : (
            <label className="project-form__field">
              <span className="project-form__label">
                {isPull ? 'Local destination folder' : 'Destination folder'} under target root
              </span>
              <input
                className="cfg-prop-input cfg-prop-input--tall"
                value={destinationFolder}
                onChange={(event) => setDestinationFolder(event.target.value)}
              />
              <span className="project-form__hint">
                A folder name only; absolute paths are rejected.
              </span>
            </label>
          )}
          <label className="mgr-mcp-toggle">
            <input
              type="checkbox"
              checked={start}
              onChange={(event) => setStart(event.target.checked)}
            />
            <span>Start the {isPull ? 'local' : 'destination'} project after transfer</span>
          </label>
        </>
      )}

      {transfer && (
        <div className="project-form__field">
          <span className="project-form__label">
            {transfer.status === 'active' ? transfer.phase : transfer.message || transfer.status}
          </span>
          <progress value={pct} max={100} />
          {transfer.status === 'active' && (
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
          {(transfer.status === 'error' || transfer.status === 'cancelled') && (
            <Button variant="primary" disabled={busy} onClick={() => void submit()}>
              Retry with same transfer ID
            </Button>
          )}
        </div>
      )}
      {fingerprint && (
        <p className="project-form__hint">
          Pinned certificate SHA-256: <code>{fingerprint}</code>
        </p>
      )}
      {error && <p className="project-form__status project-form__status--error">{error}</p>}
      {certificateChanged && (
        <Button variant="ghost" disabled={busy} onClick={() => void forgetCertificate()}>
          Forget pinned certificate and retry
        </Button>
      )}
      <div className="name-modal__actions">
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        {paired && !transfer && (
          <Button variant="primary" disabled={!canTransfer} onClick={() => void submit()}>
            {isPull ? 'Pull' : 'Transfer'}
          </Button>
        )}
      </div>
    </ModalShell>
  );
}
