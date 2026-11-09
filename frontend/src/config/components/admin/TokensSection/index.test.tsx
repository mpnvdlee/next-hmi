import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TokensSection from './index';
import { listTokens, revokeToken, type ListedToken } from './tokensApi';

vi.mock('./tokensApi', () => ({
  listTokens: vi.fn(),
  revokeToken: vi.fn(),
  createApiToken: vi.fn(),
  createMcpToken: vi.fn(),
  listPairedDevices: vi.fn(async () => []),
  revokePairedDevice: vi.fn(),
}));

function token(overrides: Partial<ListedToken> = {}): ListedToken {
  return {
    id: 'tok-a',
    kind: 'mcp',
    name: 'Laptop',
    access: 'read',
    createdAt: '2026-11-01T10:00:00Z',
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

it('lists every token and revokes one', async () => {
  const user = userEvent.setup();
  vi.mocked(listTokens)
    .mockResolvedValueOnce([
      token(),
      token({ id: 'tok-h', kind: 'api', name: 'HR', scopes: ['users:read'] }),
    ])
    .mockResolvedValue([]);
  vi.mocked(revokeToken).mockResolvedValue(undefined);
  render(<TokensSection />);

  const row = (await screen.findByText('Laptop')).closest('tr') as HTMLElement;
  expect(within(row).getByText('Read')).toBeInTheDocument();
  const apiRow = screen.getByText('HR').closest('tr') as HTMLElement;
  expect(within(apiRow).getByText('users:read')).toBeInTheDocument();

  await act(() => user.click(screen.getByRole('button', { name: /^Revoke Laptop, created / })));

  expect(revokeToken).toHaveBeenCalledWith('tok-a');
  await waitFor(() => expect(screen.queryByText('Laptop')).not.toBeInTheDocument());
  expect(screen.getByText('No tokens yet.')).toBeInTheDocument();
});
