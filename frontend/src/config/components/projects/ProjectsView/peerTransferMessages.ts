const PHASE_LABELS: Record<string, string> = {
  queued: 'Queued',
  packing: 'Packing the project',
  uploading: 'Uploading to peer',
  downloading: 'Downloading from peer',
  extracting: 'Extracting the archive',
  validated: 'Archive validated',
  backing_up: 'Backing up the existing project',
  backup_created: 'Backup created',
  installing: 'Installing',
  installed: 'Installed',
  committing_manifest: 'Registering the project',
  manifest_committed: 'Project registered',
  starting: 'Starting the project',
  applied_pending_start: 'Installed, waiting to start',
  complete: 'Complete',
  receipt: 'Complete',
  cancelled: 'Cancelled',
  cancelled_after_rollback: 'Cancelled and rolled back',
  error: 'Failed',
  error_after_rollback: 'Failed and rolled back',
  interrupted_retryable: 'Interrupted, can be retried',
  rolled_back_after_restart: 'Rolled back after a restart',
  recovery_required: 'Needs administrator recovery',
};

export function phaseLabel(phase: string): string {
  return PHASE_LABELS[phase] ?? phase;
}

export interface FailureExplanation {
  cause: string;
  action?: string;
}

/**
 * Turn a backend refusal into what went wrong and what to do about it.
 *
 * Matches the sentences `manager_peers_api.py` actually emits — its own, and
 * the peer's `detail` it now forwards — so an unrecognised message still
 * reaches the operator untouched rather than being flattened into a generic
 * failure.
 *
 * `canResolve` is whether the resolution choices are on screen, so a collision
 * refusal never points at a panel that was never rendered.
 */
export function explainFailure(text: string, canResolve: boolean): FailureExplanation {
  if (text.includes('Incorrect device-admin password')) {
    return {
      cause: 'Incorrect device-admin password.',
      action: "This is the peer's device-admin password, not this manager's.",
    };
  }
  if (text.includes('Too many failed attempts')) {
    const seconds = /Try again in (\d+)s/.exec(text)?.[1];
    return {
      cause: 'The peer locked out pairing after repeated failures.',
      action: seconds
        ? `Wait ${seconds} seconds, then pair again.`
        : 'Wait for the countdown the peer reported, then pair again.',
    };
  }
  if (text.includes('Could not resolve peer host')) {
    return {
      cause: 'That host name did not resolve.',
      action: 'Use the peer’s IP address, or pick the peer from the discovery list.',
    };
  }
  if (text.includes('must resolve exclusively to private')) {
    return {
      cause: 'That address is not a trusted-LAN address.',
      action: 'Peer transfer refuses localhost and public addresses. Use the peer’s LAN address.',
    };
  }
  if (text.includes('Could not reach peer') || text.includes('Lost the connection to peer')) {
    if (text.includes('timed out')) {
      return {
        cause: 'The peer did not answer in time.',
        action:
          'Check it is powered on and on this network — a firewall can swallow a connection instead of refusing it.',
      };
    }
    if (text.includes('was refused')) {
      return {
        cause: 'Nothing is listening on that address and port.',
        action:
          'A packaged install serves 8000 (8443 with HTTPS); a start-dev.py checkout serves 8001.',
      };
    }
    // The backend cannot tell a closed port from no route here — its async
    // transport drops the errno — so this says only what is certain and still
    // answers the question an operator actually has: which port?
    if (text.includes('could not be opened')) {
      return {
        cause: 'Could not open a connection to that address and port.',
        action:
          'Check the peer is running and that the port is right — a packaged install serves 8000 (8443 with HTTPS); a start-dev.py checkout serves 8001.',
      };
    }
    // A reset or a read error: the backend already names the cause and the
    // address it used. Flattening those into "the port is closed" would be a
    // confident wrong answer.
    return { cause: text };
  }
  if (text.includes('HTTP 403') || text.includes('Peer source')) {
    return {
      cause: 'The peer refused this manager’s address.',
      action:
        'It saw the request arrive from outside its trusted LAN. Both managers must sit on the same private network.',
    };
  }
  if (text.includes('Could not start a TLS session')) {
    return {
      cause: 'The TLS handshake with the peer failed.',
      action: 'Check the peer serves HTTPS on that port, or switch the protocol to HTTP.',
    };
  }
  if (text.includes('Certificate for peer')) {
    return {
      cause: text,
      action:
        'If the peer’s certificate was renewed on purpose, forget the pinned certificate and pair again.',
    };
  }
  if (text.includes('use a new id')) {
    return {
      cause: 'The project changed since this transfer id was first used.',
      action:
        'The archive no longer matches that first attempt, so this id can never succeed. Start a new transfer.',
    };
  }
  if (text.includes('project id or folder already exists')) {
    return {
      cause: 'A project or folder of that name already exists on the target.',
      action: canResolve
        ? 'Choose a different destination folder, or pick a resolution below.'
        : 'Choose a different destination folder.',
    };
  }
  return { cause: text };
}
