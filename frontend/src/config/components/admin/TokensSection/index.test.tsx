import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TokensSection from './index';
import { listTokens, projectMcpEnabled, revokeToken, type ListedToken } from './tokensApi';

vi.mock('./tokensApi', () => ({
  listTokens: vi.fn(),
  projectMcpEnabled: vi.fn(),
  revokeToken: vi.fn(),
  createApiToken: vi.fn(),
  createMcpToken: vi.fn(),
}));

function token(overrides: Partial<ListedToken> = {}): ListedToken {
  return {
    id: 'tok-a',
    kind: 'mcp',
    name: 'Laptop',
    projectId: 'p1',
    access: 'read',
    createdAt: '2026-11-01T10:00:00Z',
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

it("lists only this project's tokens and revokes one", async () => {
  const user = userEvent.setup();
  vi.mocked(listTokens)
    .mockResolvedValueOnce([
      token(),
      token({ id: 'tok-h', kind: 'api', name: 'HR', scopes: ['users:read'] }),
      token({ id: 'tok-b', name: 'Other', projectId: 'p2' }),
    ])
    .mockResolvedValue([]);
  vi.mocked(revokeToken).mockResolvedValue(undefined);
  render(<TokensSection projectId="p1" />);

  const row = (await screen.findByText('Laptop')).closest('tr') as HTMLElement;
  expect(within(row).getByText('Read')).toBeInTheDocument();
  const apiRow = screen.getByText('HR').closest('tr') as HTMLElement;
  expect(within(apiRow).getByText('users:read')).toBeInTheDocument();
  expect(screen.queryByText('Other')).not.toBeInTheDocument();

  await act(() => user.click(screen.getByRole('button', { name: /^Revoke Laptop, created / })));

  expect(revokeToken).toHaveBeenCalledWith('tok-a');
  await waitFor(() => expect(screen.queryByText('Laptop')).not.toBeInTheDocument());
  expect(screen.getByText('No tokens yet.')).toBeInTheDocument();
});

it("opens the create dialog with the project's MCP switch read fresh", async () => {
  const user = userEvent.setup();
  vi.mocked(listTokens).mockResolvedValue([]);
  vi.mocked(projectMcpEnabled).mockResolvedValue(false);
  render(<TokensSection projectId="p1" />);
  await screen.findByText('No tokens yet.');

  await user.click(screen.getByRole('button', { name: 'Create token' }));
  await user.click(await screen.findByRole('radio', { name: 'Write' }));

  expect(projectMcpEnabled).toHaveBeenCalledWith('p1');
  expect(screen.getByText(/Writes are refused/)).toBeInTheDocument();
});
