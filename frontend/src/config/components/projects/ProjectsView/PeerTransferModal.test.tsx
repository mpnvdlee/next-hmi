import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useProjectsStore, type PeerProject, type ProjectEntry } from '@config/store/projectsStore';
import PeerTransferModal from './PeerTransferModal';

function project(overrides: Partial<ProjectEntry> = {}): ProjectEntry {
  return {
    id: 'p1',
    name: 'Line 1',
    path: '/projects/p1',
    addedAt: '2024-01-01T00:00:00Z',
    lastOpenedAt: null,
    status: 'present',
    inProjectsRoot: true,
    isDefault: false,
    mcpEnabled: false,
    credentialsStatus: 'ok',
    credentialsError: null,
    formatVersion: null,
    minAppVersion: null,
    needsUpgrade: false,
    unsupportedFormat: false,
    lastMigration: null,
    thumbnailUpdatedAt: null,
    ...overrides,
  };
}

const INITIAL = useProjectsStore.getState();

beforeAll(() => {
  // jsdom has no scrollIntoView; Select's active-option effect calls it.
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  useProjectsStore.setState(INITIAL, true);
});

it('offers "forget pinned certificate" when a mid-transfer pin mismatch arrives on transfer.message', async () => {
  const user = userEvent.setup();

  useProjectsStore.setState({
    loadPeers: vi.fn().mockResolvedValue({ discovered: [], manual: [] }),
    pairPeer: vi.fn().mockResolvedValue({ token: 'tok', certificateFingerprint: 'abcd' }),
    listPeerProjects: vi.fn().mockResolvedValue([]),
    beginPeerTransfer: vi.fn().mockResolvedValue({
      transferId: 'tx-1',
      phase: 'uploading',
      status: 'active',
      bytesDone: 0,
      bytesTotal: 100,
    }),
    getPeerTransfer: vi.fn().mockResolvedValue({
      transferId: 'tx-1',
      phase: 'uploading',
      status: 'error',
      bytesDone: 0,
      bytesTotal: 100,
      // The mismatch surfaces here — a 200 response whose body says the
      // transfer itself failed — never through the request-level `error`
      // state the poller's own `.catch` would populate.
      message: 'Certificate for peer 10.0.0.4:8000 changed. Pinned abcd…, peer now presents ef01….',
    }),
  });

  render(
    <PeerTransferModal
      direction="push"
      source={project()}
      onClose={vi.fn()}
      onTransferred={vi.fn()}
    />,
  );

  await user.type(screen.getByPlaceholderText('192.168.1.20'), '10.0.0.4');
  await user.type(screen.getByLabelText(/device-admin password/i), 'secret');
  await user.click(screen.getByRole('button', { name: 'Pair & continue' }));

  await user.type(await screen.findByLabelText(/Destination folder/i), 'landing');
  await user.click(screen.getByRole('button', { name: 'Transfer' }));

  expect(screen.queryByText('Forget pinned certificate and retry')).not.toBeInTheDocument();

  await waitFor(
    () => expect(screen.getByText('Forget pinned certificate and retry')).toBeInTheDocument(),
    { timeout: 3000 },
  );
});

it('clears the mismatch panel and button once the pinned certificate is forgotten', async () => {
  const user = userEvent.setup();

  useProjectsStore.setState({
    loadPeers: vi.fn().mockResolvedValue({ discovered: [], manual: [] }),
    pairPeer: vi.fn().mockResolvedValue({ token: 'tok', certificateFingerprint: 'abcd' }),
    listPeerProjects: vi.fn().mockResolvedValue([]),
    beginPeerTransfer: vi.fn().mockResolvedValue({
      transferId: 'tx-1',
      phase: 'uploading',
      status: 'active',
      bytesDone: 0,
      bytesTotal: 100,
    }),
    getPeerTransfer: vi.fn().mockResolvedValue({
      transferId: 'tx-1',
      phase: 'uploading',
      status: 'error',
      bytesDone: 0,
      bytesTotal: 100,
      message: 'Certificate for peer 10.0.0.4:8000 changed. Pinned abcd…, peer now presents ef01….',
    }),
    forgetPeerCertificate: vi.fn().mockResolvedValue(undefined),
  });

  render(
    <PeerTransferModal
      direction="push"
      source={project()}
      onClose={vi.fn()}
      onTransferred={vi.fn()}
    />,
  );

  await user.type(screen.getByPlaceholderText('192.168.1.20'), '10.0.0.4');
  await user.type(screen.getByLabelText(/device-admin password/i), 'secret');
  await user.click(screen.getByRole('button', { name: 'Pair & continue' }));

  await user.type(await screen.findByLabelText(/Destination folder/i), 'landing');
  await user.click(screen.getByRole('button', { name: 'Transfer' }));

  const forgetButton = await screen.findByRole('button', {
    name: 'Forget pinned certificate and retry',
  });
  expect(screen.getByText(/Certificate for peer 10\.0\.0\.4:8000 changed/)).toBeInTheDocument();

  await user.click(forgetButton);

  // Before the fix, `setError(null)` left `transfer.message` holding the
  // mismatch, so both the red panel and this button outlived the forget.
  await waitFor(() =>
    expect(
      screen.queryByText(/Certificate for peer 10\.0\.0\.4:8000 changed/),
    ).not.toBeInTheDocument(),
  );
  expect(
    screen.queryByRole('button', { name: 'Forget pinned certificate and retry' }),
  ).not.toBeInTheDocument();
});

interface BeginArgs {
  transferId: string;
  collisionPolicy: string;
  destinationProjectId: string;
  destinationFolder: string;
  confirmReplace: boolean;
}

function stubStore(remoteProjects: PeerProject[], overrides: Record<string, unknown> = {}) {
  const beginPeerTransfer = vi.fn(async (args: BeginArgs) => ({
    transferId: args.transferId,
    phase: 'uploading',
    status: 'active' as const,
    bytesDone: 0,
    bytesTotal: 100,
  }));
  useProjectsStore.setState({
    loadPeers: vi.fn().mockResolvedValue({ discovered: [], manual: [] }),
    pairPeer: vi.fn().mockResolvedValue({ token: 'tok', certificateFingerprint: null }),
    listPeerProjects: vi.fn().mockResolvedValue(remoteProjects),
    beginPeerTransfer,
    ...overrides,
  });
  return beginPeerTransfer;
}

function stubPullStore(remoteProjects: PeerProject[], overrides: Record<string, unknown> = {}) {
  const beginPeerPull = vi.fn(async (args: BeginArgs) => ({
    transferId: args.transferId,
    phase: 'downloading',
    status: 'active' as const,
    bytesDone: 0,
    bytesTotal: 100,
  }));
  useProjectsStore.setState({
    loadPeers: vi.fn().mockResolvedValue({ discovered: [], manual: [] }),
    pairPeer: vi.fn().mockResolvedValue({ token: 'tok', certificateFingerprint: null }),
    listPeerProjects: vi.fn().mockResolvedValue(remoteProjects),
    beginPeerPull,
    ...overrides,
  });
  return beginPeerPull;
}

async function pairWith(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText('192.168.1.20'), '10.0.0.4');
  await user.type(screen.getByLabelText(/device-admin password/i), 'secret');
  await user.click(screen.getByRole('button', { name: 'Pair & continue' }));
}

async function pick(user: ReturnType<typeof userEvent.setup>, combobox: string, option: RegExp) {
  await user.click(await screen.findByRole('combobox', { name: combobox }));
  await user.click(await screen.findByRole('option', { name: option }));
}

it('asks nothing about collisions when the peer has no clashing project', async () => {
  const user = userEvent.setup();
  const beginPeerTransfer = stubStore([
    { id: 'other', name: 'Other', folder: 'other', running: false },
  ]);

  render(
    <PeerTransferModal
      direction="push"
      source={project()}
      onClose={vi.fn()}
      onTransferred={vi.fn()}
    />,
  );

  await pairWith(user);

  const folder = await screen.findByLabelText(/Destination folder/i);
  await user.clear(folder);
  await user.type(folder, 'line-1');

  expect(screen.queryByRole('radio', { name: /separate copy/i })).not.toBeInTheDocument();
  expect(screen.getByText(/has no project or folder named "line-1"/)).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Transfer' }));

  expect(beginPeerTransfer).toHaveBeenCalledTimes(1);
  expect(beginPeerTransfer.mock.calls[0][0]).toMatchObject({
    collisionPolicy: 'reject',
    destinationFolder: 'line-1',
  });
});

it('names the clashing project and offers resolutions when the ids collide', async () => {
  const user = userEvent.setup();
  stubStore([{ id: 'p1', name: 'Line 1 on peer', folder: 'elsewhere', running: false }]);

  render(
    <PeerTransferModal
      direction="push"
      source={project()}
      onClose={vi.fn()}
      onTransferred={vi.fn()}
    />,
  );

  await pairWith(user);

  expect(await screen.findByText(/"Line 1 on peer"/)).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: /Don’t overwrite anything/ })).toBeChecked();
  expect(screen.getByRole('radio', { name: /separate copy/i })).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: /Replace the existing project/i })).toBeInTheDocument();
});

it('suggests a free folder for the copy option when the folder collides', async () => {
  const user = userEvent.setup();
  stubStore([
    { id: 'other', name: 'Landing', folder: 'landing', running: false },
    { id: 'other-2', name: 'Landing 2', folder: 'landing-2', running: false },
  ]);

  render(
    <PeerTransferModal
      direction="push"
      source={project()}
      onClose={vi.fn()}
      onTransferred={vi.fn()}
    />,
  );

  await pairWith(user);

  const folder = await screen.findByLabelText(/Destination folder/i);
  await user.clear(folder);
  await user.type(folder, 'landing');

  expect(screen.getByText(/"Landing"/)).toBeInTheDocument();

  await user.click(screen.getByRole('radio', { name: /separate copy/i }));

  expect(await screen.findByLabelText(/Destination folder/i)).toHaveValue('landing-3');
});

it('reopens the form after a failure and only mints a new id when parameters change', async () => {
  const user = userEvent.setup();
  const beginPeerTransfer = stubStore(
    [{ id: 'p1', name: 'Line 1 on peer', folder: 'elsewhere', running: false }],
    {
      getPeerTransfer: vi.fn(async (transferId: string) => ({
        transferId,
        phase: 'error',
        status: 'error',
        bytesDone: 0,
        bytesTotal: 100,
        message: 'Destination project id or folder already exists',
      })),
    },
  );

  render(
    <PeerTransferModal
      direction="push"
      source={project()}
      onClose={vi.fn()}
      onTransferred={vi.fn()}
    />,
  );

  await pairWith(user);
  await user.click(await screen.findByRole('button', { name: 'Transfer' }));

  await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument(), {
    timeout: 3000,
  });
  expect(
    screen.getByText('A project or folder of that name already exists on the target.'),
  ).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(beginPeerTransfer).toHaveBeenCalledTimes(2), { timeout: 3000 });
  expect(beginPeerTransfer.mock.calls[1][0].transferId).toBe(
    beginPeerTransfer.mock.calls[0][0].transferId,
  );

  await waitFor(() => expect(screen.getByRole('radio', { name: /separate copy/i })).toBeEnabled(), {
    timeout: 3000,
  });
  await user.click(screen.getByRole('radio', { name: /separate copy/i }));

  const newTransfer = await screen.findByRole('button', { name: 'Start a new transfer' });
  await user.click(newTransfer);

  await waitFor(() => expect(beginPeerTransfer).toHaveBeenCalledTimes(3), { timeout: 3000 });
  expect(beginPeerTransfer.mock.calls[2][0].transferId).not.toBe(
    beginPeerTransfer.mock.calls[0][0].transferId,
  );
  expect(beginPeerTransfer.mock.calls[2][0].collisionPolicy).toBe('copy');
});

it('names a wrong device-admin password instead of showing a generic failure', async () => {
  const user = userEvent.setup();
  stubStore([], {
    pairPeer: vi
      .fn()
      .mockRejectedValue(new Error('Peer pairing failed: Incorrect device-admin password')),
  });

  render(
    <PeerTransferModal
      direction="push"
      source={project()}
      onClose={vi.fn()}
      onTransferred={vi.fn()}
    />,
  );

  await pairWith(user);

  expect(await screen.findByText('Incorrect device-admin password.')).toBeInTheDocument();
  expect(
    screen.getByText("This is the peer's device-admin password, not this manager's."),
  ).toBeInTheDocument();
  expect(screen.getByLabelText(/device-admin password/i)).toHaveValue('secret');
});

it('opens the resolutions when the backend refuses a collision the modal could not see', async () => {
  // A project removed without deleting its folder leaves an unregistered
  // directory: nothing to find in the registry, but the backend's reject rule
  // is a filesystem check and refuses anyway.
  const user = userEvent.setup();
  stubStore([], {
    getPeerTransfer: vi.fn(async (transferId: string) => ({
      transferId,
      phase: 'error',
      status: 'error' as const,
      bytesDone: 0,
      bytesTotal: 100,
      message: 'Destination rejected transfer: Destination project id or folder already exists',
    })),
  });

  render(
    <PeerTransferModal
      direction="push"
      source={project()}
      onClose={vi.fn()}
      onTransferred={vi.fn()}
    />,
  );

  await pairWith(user);
  const folder = await screen.findByLabelText(/Destination folder/i);
  await user.clear(folder);
  await user.type(folder, 'landing');

  expect(screen.queryByRole('radio', { name: /separate copy/i })).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Transfer' }));

  await waitFor(
    () => expect(screen.getByRole('radio', { name: /separate copy/i })).toBeInTheDocument(),
    { timeout: 3000 },
  );
  expect(
    screen.getByText('A project or folder of that name already exists on the target.'),
  ).toBeInTheDocument();
  expect(
    screen.getByText('Choose a different destination folder, or pick a resolution below.'),
  ).toBeInTheDocument();

  // The occupied folder is invisible to `takenFolders`, so the copy option has
  // to move off it on the refusal's evidence alone.
  await user.click(screen.getByRole('radio', { name: /separate copy/i }));
  expect(await screen.findByLabelText(/Destination folder/i)).toHaveValue('landing-2');
});

it('stops pointing at resolutions once the refused folder name is retyped', async () => {
  const user = userEvent.setup();
  stubStore([], {
    getPeerTransfer: vi.fn(async (transferId: string) => ({
      transferId,
      phase: 'error',
      status: 'error' as const,
      bytesDone: 0,
      bytesTotal: 100,
      message: 'Destination project id or folder already exists',
    })),
  });

  render(
    <PeerTransferModal
      direction="push"
      source={project()}
      onClose={vi.fn()}
      onTransferred={vi.fn()}
    />,
  );

  await pairWith(user);
  const folder = await screen.findByLabelText(/Destination folder/i);
  await user.clear(folder);
  await user.type(folder, 'landing');
  await user.click(screen.getByRole('button', { name: 'Transfer' }));

  await waitFor(
    () => expect(screen.getByRole('radio', { name: /separate copy/i })).toBeInTheDocument(),
    { timeout: 3000 },
  );

  await user.type(await screen.findByLabelText(/Destination folder/i), '-b');

  expect(screen.queryByRole('radio', { name: /separate copy/i })).not.toBeInTheDocument();
  expect(screen.getByText('Choose a different destination folder.')).toBeInTheDocument();
});

it('does not call a project registered outside the projects root a folder clash', async () => {
  const user = userEvent.setup();
  stubPullStore([{ id: 'remote-1', name: 'Landing', folder: 'landing', running: false }], {
    projects: [
      project({
        id: 'local-1',
        name: 'Landing elsewhere',
        path: '/elsewhere/landing',
        inProjectsRoot: false,
      }),
    ],
  });

  render(<PeerTransferModal direction="pull" onClose={vi.fn()} onTransferred={vi.fn()} />);

  await pairWith(user);
  await pick(user, 'Source project on peer', /Landing \(landing\)/);

  expect(await screen.findByLabelText(/Local destination folder/i)).toHaveValue('landing');
  expect(screen.queryByRole('radio', { name: /separate copy/i })).not.toBeInTheDocument();
  expect(
    screen.getByText('This manager has no project or folder named "landing".'),
  ).toBeInTheDocument();
});

it('names the local project in the way when it really is in the projects root', async () => {
  const user = userEvent.setup();
  const beginPeerPull = stubPullStore(
    [{ id: 'remote-1', name: 'Landing', folder: 'landing', running: false }],
    {
      projects: [
        project({
          id: 'local-1',
          name: 'Landing here',
          path: '/projects/landing',
          inProjectsRoot: true,
        }),
      ],
    },
  );

  render(<PeerTransferModal direction="pull" onClose={vi.fn()} onTransferred={vi.fn()} />);

  await pairWith(user);
  await pick(user, 'Source project on peer', /Landing \(landing\)/);

  expect(
    await screen.findByText('This manager already has "Landing here" in the folder "landing".'),
  ).toBeInTheDocument();

  await user.click(screen.getByRole('radio', { name: /separate copy/i }));
  expect(await screen.findByLabelText(/Local destination folder/i)).toHaveValue('landing-2');

  await user.click(screen.getByRole('button', { name: 'Pull' }));
  expect(beginPeerPull).toHaveBeenCalledTimes(1);
  expect(beginPeerPull.mock.calls[0][0]).toMatchObject({
    collisionPolicy: 'copy',
    destinationFolder: 'landing-2',
  });
});

it.each([
  [
    'Could not reach peer 10.0.0.4:8000 at 10.0.0.4: the connection was refused',
    'Nothing is listening on that address and port.',
  ],
  [
    'Could not reach peer 10.0.0.4:8000 at 10.0.0.4: the connection timed out',
    'The peer did not answer in time.',
  ],
])('tells a refused port apart from a silent one: %s', async (message, expected) => {
  const user = userEvent.setup();
  stubStore([], { pairPeer: vi.fn().mockRejectedValue(new Error(message)) });

  render(
    <PeerTransferModal
      direction="push"
      source={project()}
      onClose={vi.fn()}
      onTransferred={vi.fn()}
    />,
  );

  await pairWith(user);

  expect(await screen.findByText(expected)).toBeInTheDocument();
});

it('still answers "which port?" when the backend cannot tell refused from unreachable', async () => {
  // The async transport loses the errno, so this is the sentence a genuinely
  // closed port produces in production — and the port hint has to survive it.
  const user = userEvent.setup();
  const message =
    'Could not reach peer 10.0.0.4:8000 at 10.0.0.4: the connection could not be opened';
  stubStore([], { pairPeer: vi.fn().mockRejectedValue(new Error(message)) });

  render(
    <PeerTransferModal
      direction="push"
      source={project()}
      onClose={vi.fn()}
      onTransferred={vi.fn()}
    />,
  );

  await pairWith(user);

  expect(
    await screen.findByText('Could not open a connection to that address and port.'),
  ).toBeInTheDocument();
  expect(screen.getByText(/a packaged install serves 8000/)).toBeInTheDocument();
  expect(
    screen.queryByText('Nothing is listening on that address and port.'),
  ).not.toBeInTheDocument();
});

it('shows the backend’s own sentence for a transport failure that is neither', async () => {
  const user = userEvent.setup();
  const message =
    'Lost the connection to peer 10.0.0.4:8000 at 10.0.0.4: the request failed (connection reset)';
  stubStore([], { pairPeer: vi.fn().mockRejectedValue(new Error(message)) });

  render(
    <PeerTransferModal
      direction="push"
      source={project()}
      onClose={vi.fn()}
      onTransferred={vi.fn()}
    />,
  );

  await pairWith(user);

  expect(await screen.findByText(message)).toBeInTheDocument();
  expect(
    screen.queryByText('Nothing is listening on that address and port.'),
  ).not.toBeInTheDocument();
  expect(screen.queryByText(/packaged install serves 8000/)).not.toBeInTheDocument();
});

it('explains a connection failure that happens during the transfer itself', async () => {
  const user = userEvent.setup();
  stubStore([], {
    getPeerTransfer: vi.fn(async (transferId: string) => ({
      transferId,
      phase: 'error',
      failedPhase: 'uploading',
      status: 'error' as const,
      bytesDone: 0,
      bytesTotal: 100,
      message: 'Could not reach peer 10.0.0.4:8000 at 10.0.0.4: the connection was refused',
    })),
  });

  render(
    <PeerTransferModal
      direction="push"
      source={project()}
      onClose={vi.fn()}
      onTransferred={vi.fn()}
    />,
  );

  await pairWith(user);
  await user.click(await screen.findByRole('button', { name: 'Transfer' }));

  await waitFor(
    () =>
      expect(
        screen.getByText('Nothing is listening on that address and port.'),
      ).toBeInTheDocument(),
    { timeout: 3000 },
  );
  expect(screen.getByText(/A packaged install serves 8000/)).toBeInTheDocument();
});

it('reports the phase the backend failed in, not the last one it polled', async () => {
  const user = userEvent.setup();
  stubStore([], {
    // The client-side guess still says "packing"; the backend knows better.
    beginPeerTransfer: vi.fn(async (args: BeginArgs) => ({
      transferId: args.transferId,
      phase: 'packing',
      status: 'active' as const,
      bytesDone: 0,
      bytesTotal: 100,
    })),
    getPeerTransfer: vi.fn(async (transferId: string) => ({
      transferId,
      phase: 'error',
      failedPhase: 'uploading',
      status: 'error' as const,
      bytesDone: 0,
      bytesTotal: 100,
      message: 'Could not reach peer 10.0.0.4:8000 at 10.0.0.4: the connection was refused',
    })),
  });

  render(
    <PeerTransferModal
      direction="push"
      source={project()}
      onClose={vi.fn()}
      onTransferred={vi.fn()}
    />,
  );

  await pairWith(user);
  await user.click(await screen.findByRole('button', { name: 'Transfer' }));

  await waitFor(
    () => expect(screen.getByText('Failed while uploading to peer')).toBeInTheDocument(),
    { timeout: 3000 },
  );
  expect(screen.queryByText(/while packing the project/i)).not.toBeInTheDocument();
});

it('mints a new transfer id when the id itself can never succeed again', async () => {
  const user = userEvent.setup();
  const beginPeerTransfer = stubStore([], {
    getPeerTransfer: vi.fn(async (transferId: string) => ({
      transferId,
      phase: 'error',
      failedPhase: 'packing',
      status: 'error' as const,
      bytesDone: 0,
      bytesTotal: 100,
      message: 'Source project changed since this transferId was first attempted; use a new id',
    })),
  });

  render(
    <PeerTransferModal
      direction="push"
      source={project()}
      onClose={vi.fn()}
      onTransferred={vi.fn()}
    />,
  );

  await pairWith(user);
  await user.click(await screen.findByRole('button', { name: 'Transfer' }));

  await waitFor(
    () => expect(screen.getByRole('button', { name: 'Start a new transfer' })).toBeInTheDocument(),
    { timeout: 3000 },
  );
  expect(
    screen.getByText('The project changed since this transfer id was first used.'),
  ).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Start a new transfer' }));

  await waitFor(() => expect(beginPeerTransfer).toHaveBeenCalledTimes(2), { timeout: 3000 });
  expect(beginPeerTransfer.mock.calls[1][0].transferId).not.toBe(
    beginPeerTransfer.mock.calls[0][0].transferId,
  );
});

it('puts the confirmation and the chosen replacement on the wire', async () => {
  const user = userEvent.setup();
  const beginPeerTransfer = stubStore([
    { id: 'peer-landing', name: 'Landing', folder: 'landing', running: false },
  ]);

  render(
    <PeerTransferModal
      direction="push"
      source={project()}
      onClose={vi.fn()}
      onTransferred={vi.fn()}
    />,
  );

  await pairWith(user);
  const folder = await screen.findByLabelText(/Destination folder/i);
  await user.clear(folder);
  await user.type(folder, 'landing');

  await user.click(screen.getByRole('radio', { name: /Replace the existing project/i }));
  await pick(user, 'Destination project', /Landing \(landing\)/);
  await user.click(screen.getByRole('checkbox', { name: /Back up and replace/i }));
  await user.click(screen.getByRole('button', { name: 'Transfer' }));

  expect(beginPeerTransfer).toHaveBeenCalledTimes(1);
  expect(beginPeerTransfer.mock.calls[0][0]).toMatchObject({
    collisionPolicy: 'replace',
    confirmReplace: true,
    destinationProjectId: 'peer-landing',
    destinationFolder: 'landing',
  });
});

it('stops claiming something is in the way once the copy option frees the folder', async () => {
  const user = userEvent.setup();
  stubStore([{ id: 'other', name: 'Landing', folder: 'landing', running: false }]);

  render(
    <PeerTransferModal
      direction="push"
      source={project()}
      onClose={vi.fn()}
      onTransferred={vi.fn()}
    />,
  );

  await pairWith(user);
  const folder = await screen.findByLabelText(/Destination folder/i);
  await user.clear(folder);
  await user.type(folder, 'landing');

  expect(screen.getByText('Something is already there')).toBeInTheDocument();

  await user.click(screen.getByRole('radio', { name: /separate copy/i }));

  expect(screen.getByText('Choose how to install')).toBeInTheDocument();
  expect(screen.queryByText('Something is already there')).not.toBeInTheDocument();
  expect(screen.queryByText(/no project or folder in the way/)).not.toBeInTheDocument();
});

it('keeps the explanation of a terminal status the durable journal owns', async () => {
  // Pull, not push: only an installing client reaches `applied_pending_start`.
  // A sender's journal never leaves active/complete/error/cancelled.
  const user = userEvent.setup();
  stubPullStore([{ id: 'remote-1', name: 'Landing', folder: 'landing', running: false }], {
    getPeerPull: vi.fn(async (transferId: string) => ({
      transferId,
      phase: 'applied_pending_start',
      status: 'applied_pending_start' as const,
      bytesDone: 100,
      bytesTotal: 100,
      message: 'Project did not start: port 8001 is already in use',
    })),
  });

  render(<PeerTransferModal direction="pull" onClose={vi.fn()} onTransferred={vi.fn()} />);

  await pairWith(user);
  await pick(user, 'Source project on peer', /Landing \(landing\)/);
  await user.click(await screen.findByRole('button', { name: 'Pull' }));

  await waitFor(() => expect(screen.getByText('Installed, waiting to start')).toBeInTheDocument(), {
    timeout: 3000,
  });
  expect(
    screen.getByText('Project did not start: port 8001 is already in use'),
  ).toBeInTheDocument();
});

it('does not call a peer project registered outside its projects root a folder clash', async () => {
  const user = userEvent.setup();
  const beginPeerTransfer = stubStore([
    {
      id: 'peer-1',
      name: 'Landing on peer',
      folder: 'landing',
      running: false,
      inProjectsRoot: false,
    },
  ]);

  render(
    <PeerTransferModal
      direction="push"
      source={project()}
      onClose={vi.fn()}
      onTransferred={vi.fn()}
    />,
  );

  await pairWith(user);
  const folder = await screen.findByLabelText(/Destination folder/i);
  await user.clear(folder);
  await user.type(folder, 'landing');

  expect(screen.queryByRole('radio', { name: /separate copy/i })).not.toBeInTheDocument();
  expect(screen.getByText(/has no project or folder named "landing"/)).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Transfer' }));
  expect(beginPeerTransfer.mock.calls[0][0]).toMatchObject({
    collisionPolicy: 'reject',
    destinationFolder: 'landing',
  });
});

it('will not offer a peer project outside its projects root as a replacement', async () => {
  // The backend refuses `replace` for one of these every time — its folder is
  // not the folder an install lands in, however much the name suggests it.
  const user = userEvent.setup();
  stubStore([
    {
      id: 'p1',
      name: 'Line 1 on peer',
      folder: 'elsewhere',
      running: false,
      inProjectsRoot: false,
    },
  ]);

  render(
    <PeerTransferModal
      direction="push"
      source={project()}
      onClose={vi.fn()}
      onTransferred={vi.fn()}
    />,
  );

  await pairWith(user);

  expect(await screen.findByText(/"Line 1 on peer"/)).toBeInTheDocument();
  await user.click(screen.getByRole('radio', { name: /Replace the existing project/i }));

  expect(
    screen.getByText('10.0.0.4 has no project in its projects root to replace.'),
  ).toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: 'Destination project' })).not.toBeInTheDocument();
});

it('moves off a refused folder even when the clash it could see was an id clash', async () => {
  const user = userEvent.setup();
  stubStore([{ id: 'p1', name: 'Line 1 on peer', folder: 'elsewhere', running: false }], {
    getPeerTransfer: vi.fn(async (transferId: string) => ({
      transferId,
      phase: 'error',
      status: 'error' as const,
      bytesDone: 0,
      bytesTotal: 100,
      message: 'Destination project id or folder already exists',
    })),
  });

  render(
    <PeerTransferModal
      direction="push"
      source={project()}
      onClose={vi.fn()}
      onTransferred={vi.fn()}
    />,
  );

  await pairWith(user);
  const folder = await screen.findByLabelText(/Destination folder/i);
  await user.clear(folder);
  await user.type(folder, 'landing');
  await user.click(screen.getByRole('button', { name: 'Transfer' }));

  await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument(), {
    timeout: 3000,
  });

  // The registered clash is on the id; the folder is occupied by something the
  // registry cannot see. Both are in the way, and the copy has to clear both.
  await user.click(screen.getByRole('radio', { name: /separate copy/i }));
  expect(await screen.findByLabelText(/Destination folder/i)).toHaveValue('landing-2');
});

it('moves off a refused folder when the refusal lands with the copy already chosen', async () => {
  const user = userEvent.setup();
  stubStore([{ id: 'p1', name: 'Line 1 on peer', folder: 'elsewhere', running: false }], {
    getPeerTransfer: vi.fn(async (transferId: string) => ({
      transferId,
      phase: 'error',
      status: 'error' as const,
      bytesDone: 0,
      bytesTotal: 100,
      message: 'Destination project id or folder already exists',
    })),
  });

  render(
    <PeerTransferModal
      direction="push"
      source={project()}
      onClose={vi.fn()}
      onTransferred={vi.fn()}
    />,
  );

  await pairWith(user);

  // Nothing registered holds "Line 1", so choosing the copy changes nothing.
  await user.click(await screen.findByRole('radio', { name: /separate copy/i }));
  expect(await screen.findByLabelText(/Destination folder/i)).toHaveValue('Line 1');

  await user.click(screen.getByRole('button', { name: 'Transfer' }));

  await waitFor(
    () => expect(screen.getByLabelText(/Destination folder/i)).toHaveValue('Line 1-2'),
    { timeout: 3000 },
  );
});

it('offers a peer that is both discovered and manually added only once', async () => {
  const peer = { name: 'Line 2 manager', host: '10.0.0.4', port: 8000, scheme: 'http' as const };
  useProjectsStore.setState({
    loadPeers: vi.fn().mockResolvedValue({
      discovered: [{ ...peer, source: 'mdns' as const }],
      manual: [
        { ...peer, source: 'manual' as const },
        { ...peer, port: 8443, scheme: 'https' as const, source: 'manual' as const },
      ],
    }),
  });

  const { container } = render(
    <PeerTransferModal
      direction="push"
      source={project()}
      onClose={vi.fn()}
      onTransferred={vi.fn()}
    />,
  );

  // The same host on another port is another peer, so only the duplicate goes.
  await waitFor(() =>
    expect(container.querySelectorAll('#manager-peer-hosts option')).toHaveLength(2),
  );
  const labels = [...container.querySelectorAll('#manager-peer-hosts option')].map(
    (option) => option.textContent,
  );
  expect(labels).toEqual(['http://10.0.0.4:8000', 'https://10.0.0.4:8443']);
});
