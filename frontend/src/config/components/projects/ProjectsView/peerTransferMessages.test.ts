import { describe, expect, it } from 'vitest';
import { explainFailure, phaseLabel } from './peerTransferMessages';

describe('phaseLabel', () => {
  it.each([
    ['queued', 'Queued'],
    ['packing', 'Packing the project'],
    ['uploading', 'Uploading to peer'],
    ['downloading', 'Downloading from peer'],
    ['extracting', 'Extracting the archive'],
    ['validated', 'Archive validated'],
    ['backing_up', 'Backing up the existing project'],
    ['backup_created', 'Backup created'],
    ['installing', 'Installing'],
    ['installed', 'Installed'],
    ['committing_manifest', 'Registering the project'],
    ['manifest_committed', 'Project registered'],
    ['starting', 'Starting the project'],
    ['applied_pending_start', 'Installed, waiting to start'],
    ['complete', 'Complete'],
    ['receipt', 'Complete'],
    ['cancelled', 'Cancelled'],
    ['cancelled_after_rollback', 'Cancelled and rolled back'],
    ['error', 'Failed'],
    ['error_after_rollback', 'Failed and rolled back'],
    ['interrupted_retryable', 'Interrupted, can be retried'],
    ['rolled_back_after_restart', 'Rolled back after a restart'],
    ['recovery_required', 'Needs administrator recovery'],
  ])('names the %s phase', (phase, label) => {
    expect(phaseLabel(phase)).toBe(label);
  });

  it('shows a phase it has no label for rather than nothing', () => {
    expect(phaseLabel('some_future_phase')).toBe('some_future_phase');
  });
});

interface FailureCase {
  name: string;
  /** Verbatim from `manager_peers_api.py` / `peer_trust.py`, interpolations filled in. */
  text: string;
  canResolve: boolean;
  cause: string;
  action?: string;
}

const failures: FailureCase[] = [
  {
    name: 'a wrong device-admin password',
    text: 'Incorrect device-admin password',
    canResolve: false,
    cause: 'Incorrect device-admin password.',
    action: "This is the peer's device-admin password, not this manager's.",
  },
  {
    name: 'a pairing lockout, with the countdown the peer reported',
    text: 'Too many failed attempts. Try again in 42s.',
    canResolve: false,
    cause: 'The peer locked out pairing after repeated failures.',
    action: 'Wait 42 seconds, then pair again.',
  },
  {
    name: 'a pairing lockout whose countdown did not survive',
    text: 'Too many failed attempts.',
    canResolve: false,
    cause: 'The peer locked out pairing after repeated failures.',
    action: 'Wait for the countdown the peer reported, then pair again.',
  },
  {
    name: 'a host name that does not resolve',
    text: "Could not resolve peer host 'nosuch.local': [Errno 8] nodename nor servname provided",
    canResolve: false,
    cause: 'That host name did not resolve.',
    action: 'Use the peer’s IP address, or pick the peer from the discovery list.',
  },
  {
    name: 'an address outside the trusted LAN',
    text: 'Peer host must resolve exclusively to private trusted-LAN addresses',
    canResolve: false,
    cause: 'That address is not a trusted-LAN address.',
    action: 'Peer transfer refuses localhost and public addresses. Use the peer’s LAN address.',
  },
  {
    name: 'a peer that never answered',
    text: 'Could not reach peer 10.0.0.4:8000 at 10.0.0.4: the connection timed out',
    canResolve: false,
    cause: 'The peer did not answer in time.',
    action:
      'Check it is powered on and on this network — a firewall can swallow a connection instead of refusing it.',
  },
  {
    name: 'a refused port',
    text: 'Could not reach peer 10.0.0.4:8000 at 10.0.0.4: the connection was refused',
    canResolve: false,
    cause: 'Nothing is listening on that address and port.',
    action:
      'A packaged install serves 8000 (8443 with HTTPS); a start-dev.py checkout serves 8001.',
  },
  {
    name: 'a connect failure the async transport could not classify',
    text: 'Could not reach peer 10.0.0.4:8000 at 10.0.0.4: the connection could not be opened',
    canResolve: false,
    cause: 'Could not open a connection to that address and port.',
    action:
      'Check the peer is running and that the port is right — a packaged install serves 8000 (8443 with HTTPS); a start-dev.py checkout serves 8001.',
  },
  {
    name: 'a read timeout on a live transfer connection',
    text: 'Lost the connection to peer 10.0.0.4:8000 at 10.0.0.4: the connection timed out',
    canResolve: false,
    cause: 'The peer did not answer in time.',
    action:
      'Check it is powered on and on this network — a firewall can swallow a connection instead of refusing it.',
  },
  {
    name: 'a transport failure that is neither, kept in the backend’s own words',
    text: 'Lost the connection to peer 10.0.0.4:8000 at 10.0.0.4: the request failed (ReadError)',
    canResolve: false,
    cause: 'Lost the connection to peer 10.0.0.4:8000 at 10.0.0.4: the request failed (ReadError)',
  },
  {
    name: 'a 403 whose body carried no detail',
    text: 'HTTP 403',
    canResolve: false,
    cause: 'The peer refused this manager’s address.',
    action:
      'It saw the request arrive from outside its trusted LAN. Both managers must sit on the same private network.',
  },
  {
    name: 'a peer that does not trust this manager’s source address',
    text: 'Peer source address is not trusted',
    canResolve: false,
    cause: 'The peer refused this manager’s address.',
    action:
      'It saw the request arrive from outside its trusted LAN. Both managers must sit on the same private network.',
  },
  {
    name: 'a peer that wants both managers on one private LAN',
    text: 'Peer source must be on a private trusted LAN',
    canResolve: false,
    cause: 'The peer refused this manager’s address.',
    action:
      'It saw the request arrive from outside its trusted LAN. Both managers must sit on the same private network.',
  },
  {
    name: 'a TLS handshake that never started',
    text: 'Could not start a TLS session with peer 10.0.0.4:8443: [SSL] record layer failure',
    canResolve: false,
    cause: 'The TLS handshake with the peer failed.',
    action: 'Check the peer serves HTTPS on that port, or switch the protocol to HTTP.',
  },
  {
    name: 'a pin mismatch, which keeps both fingerprints the backend named',
    text: 'Certificate for peer 10.0.0.4:8443 changed. Pinned abcd1234abcd1234…, peer now presents ef01ef01ef01ef01….',
    canResolve: false,
    cause:
      'Certificate for peer 10.0.0.4:8443 changed. Pinned abcd1234abcd1234…, peer now presents ef01ef01ef01ef01….',
    action:
      'If the peer’s certificate was renewed on purpose, forget the pinned certificate and pair again.',
  },
  {
    name: 'an expired pin, which is also a certificate sentence',
    text: 'Certificate for peer 10.0.0.4:8443 expired 3 days ago. The peer must renew and reissue a certificate; re-pinning the same expired certificate will not fix this.',
    canResolve: false,
    cause:
      'Certificate for peer 10.0.0.4:8443 expired 3 days ago. The peer must renew and reissue a certificate; re-pinning the same expired certificate will not fix this.',
    action:
      'If the peer’s certificate was renewed on purpose, forget the pinned certificate and pair again.',
  },
  {
    name: 'a transfer id that can never succeed again',
    text: 'Source project changed since this transferId was first attempted; use a new id',
    canResolve: false,
    cause: 'The project changed since this transfer id was first used.',
    action:
      'The archive no longer matches that first attempt, so this id can never succeed. Start a new transfer.',
  },
  {
    name: 'a collision, pointing at the resolutions that are on screen',
    text: 'Destination project id or folder already exists',
    canResolve: true,
    cause: 'A project or folder of that name already exists on the target.',
    action: 'Choose a different destination folder, or pick a resolution below.',
  },
  {
    name: 'a collision with no resolutions rendered to point at',
    text: 'Destination project id or folder already exists',
    canResolve: false,
    cause: 'A project or folder of that name already exists on the target.',
    action: 'Choose a different destination folder.',
  },
  {
    name: 'a collision on the copy destination',
    text: 'Copy destination project id or folder already exists',
    canResolve: false,
    cause: 'A project or folder of that name already exists on the target.',
    action: 'Choose a different destination folder.',
  },
  {
    name: 'a sentence nothing recognises, forwarded untouched',
    text: 'Project is running on the peer and cannot be replaced',
    canResolve: true,
    cause: 'Project is running on the peer and cannot be replaced',
  },
];

describe('explainFailure', () => {
  it.each(failures)('explains $name', ({ text, canResolve, cause, action }) => {
    expect(explainFailure(text, canResolve)).toEqual({ cause, action });
  });
});
