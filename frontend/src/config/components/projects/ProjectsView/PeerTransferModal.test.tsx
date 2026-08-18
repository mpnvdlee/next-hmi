import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useProjectsStore, type ProjectEntry } from '@config/store/projectsStore';
import PeerTransferModal from './PeerTransferModal';

function project(overrides: Partial<ProjectEntry> = {}): ProjectEntry {
  return {
    id: 'p1',
    name: 'Line 1',
    path: '/projects/p1',
    addedAt: '2024-01-01T00:00:00Z',
    lastOpenedAt: null,
    status: 'present',
    isDefault: false,
    mcpEnabled: false,
    operatorSetupRequired: false,
    operatorSetupStatus: 'complete',
    operatorSetupError: null,
    ...overrides,
  };
}

const INITIAL = useProjectsStore.getState();

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
