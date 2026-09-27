import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useProjectsStore } from '@config/store/projectsStore';
import { useProjectStore } from '@shared/store/projectStore';
import { useUsersDomainStore } from '@config/store/domains/usersDomainStore';
import TransferProjectButton from './TransferProjectButton';

function stubProjectsEndpoint() {
  const fetchMock = vi.fn(async (_url: string) => ({
    ok: true,
    status: 200,
    json: async () => ({ projects: [{ id: 'p1', name: 'Line 1' }] }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

let fetchMock: ReturnType<typeof stubProjectsEndpoint>;

beforeEach(() => {
  window.__NEXTHMI_BASE__ = '/editor/p1/';
  useProjectStore.setState({ dirty: false, saving: false });
  useUsersDomainStore.setState({ dirty: false, saving: false });
  useProjectsStore.setState({
    loadPeers: vi.fn().mockResolvedValue({ discovered: [], manual: [] }),
  });
  fetchMock = stubProjectsEndpoint();
});

afterEach(() => {
  delete window.__NEXTHMI_BASE__;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('reads the project list from the manager, not from the instance', async () => {
  render(<TransferProjectButton />);

  await screen.findByRole('button', { name: 'Transfer' });
  expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/projects');
});

it('renders nothing outside the manager-served editor', () => {
  delete window.__NEXTHMI_BASE__;

  const { container } = render(<TransferProjectButton />);

  expect(container).toBeEmptyDOMElement();
});

it('disables the button while the project has unsaved changes', async () => {
  useProjectStore.setState({ dirty: true });

  render(<TransferProjectButton />);

  const button = await screen.findByRole('button', { name: 'Transfer' });
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute('title', 'Save your changes before transferring');
});

it('disables the button while security changes are unsaved', async () => {
  useUsersDomainStore.setState({ dirty: true });

  render(<TransferProjectButton />);

  expect(await screen.findByRole('button', { name: 'Transfer' })).toBeDisabled();
});

it('opens a push transfer for the project the editor is serving', async () => {
  const user = userEvent.setup();

  render(<TransferProjectButton />);

  const button = await screen.findByRole('button', { name: 'Transfer' });
  expect(button).toBeEnabled();
  await user.click(button);

  await waitFor(() => {
    expect(screen.getByText('Transfer "Line 1" to a peer')).toBeInTheDocument();
  });
});

it('titles the modal with something readable when the name lookup fails', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
  );
  const user = userEvent.setup();

  render(<TransferProjectButton />);

  await user.click(await screen.findByRole('button', { name: 'Transfer' }));

  expect(await screen.findByText('Transfer "this project" to a peer')).toBeInTheDocument();
  expect(screen.queryByText('Transfer "p1" to a peer')).not.toBeInTheDocument();
});

it('leaves the modal open once a push transfer completes, so the result shows', async () => {
  const user = userEvent.setup();
  useProjectsStore.setState({
    loadPeers: vi.fn().mockResolvedValue({ discovered: [], manual: [] }),
    pairPeer: vi.fn().mockResolvedValue({ token: 'tok' }),
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
      phase: 'complete',
      status: 'complete',
      bytesDone: 100,
      bytesTotal: 100,
      message: 'Transferred successfully',
    }),
  });

  render(<TransferProjectButton />);

  await user.click(await screen.findByRole('button', { name: 'Transfer' }));
  await user.type(screen.getByPlaceholderText('192.168.1.20'), '10.0.0.4');
  await user.type(screen.getByLabelText(/device-admin password/i), 'secret');
  await user.click(screen.getByRole('button', { name: 'Pair & continue' }));

  await user.type(await screen.findByLabelText(/Destination folder/i), 'landing');
  const submitButtons = screen.getAllByRole('button', { name: 'Transfer' });
  await user.click(submitButtons[submitButtons.length - 1]);

  await waitFor(() => expect(screen.getByText('Transferred successfully')).toBeInTheDocument(), {
    timeout: 3000,
  });
  // A closed-on-complete modal (the old editor-mount behaviour) would unmount
  // this along with everything else the moment the poller reported "complete".
  expect(screen.getByText('Transfer "Line 1" to a peer')).toBeInTheDocument();
});
