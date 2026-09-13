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
  useProjectsStore.setState({ loadPeers: vi.fn().mockResolvedValue({ discovered: [], manual: [] }) });
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
