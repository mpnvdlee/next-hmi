import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CreateTokenModal from './CreateTokenModal';
import { createApiToken, createMcpToken, type IssuedMcpToken } from './tokensApi';

vi.mock('./tokensApi', () => ({ createApiToken: vi.fn(), createMcpToken: vi.fn() }));

const ISSUED: IssuedMcpToken = {
  kind: 'mcp',
  tokenId: 'tok-new',
  token: 'tok-new.SECRET',
  access: 'write',
  transport: 'http',
};

/** Create resolves after the click does; act() holds the test until its updates land. */
const settle = (click: Promise<void>) => act(() => click);

function renderModal() {
  const onCreated = vi.fn();
  const onClose = vi.fn();
  render(<CreateTokenModal onCreated={onCreated} onClose={onClose} />);
  return { onCreated, onClose };
}

afterEach(() => {
  vi.clearAllMocks();
});

it('creates a token for every project, shows it once with agent-neutral config, and copies it', async () => {
  const user = userEvent.setup();
  vi.mocked(createMcpToken).mockResolvedValue(ISSUED);
  const { onCreated } = renderModal();

  await user.type(screen.getByLabelText(/^Token name/), 'Agent');
  await user.click(screen.getByRole('radio', { name: 'Write' }));
  await settle(user.click(screen.getByRole('button', { name: 'Create token' })));

  expect(createMcpToken).toHaveBeenCalledWith('write', 'Agent');
  expect(onCreated).toHaveBeenCalledTimes(1);
  expect(await screen.findByText('tok-new.SECRET')).toBeInTheDocument();
  expect(screen.getByText(/only a hash of it is stored/i)).toHaveFocus();
  const url = `${window.location.origin}/mcp/`;
  expect(screen.getByText(url)).toBeInTheDocument();
  expect(screen.queryByText(/claude/i)).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Copy Client config (JSON)' }));
  expect(JSON.parse(await navigator.clipboard.readText())).toEqual({
    mcpServers: {
      nexthmi: { type: 'http', url, headers: { Authorization: 'Bearer tok-new.SECRET' } },
    },
  });
  expect(screen.getByRole('status')).toHaveTextContent('Client config (JSON) copied');

  // Leaving the result view drops the secret; there is no way back to it.
  await user.click(screen.getByRole('button', { name: 'Create another' }));
  expect(screen.queryByText('tok-new.SECRET')).not.toBeInTheDocument();
  expect(screen.getByLabelText(/^Token name/)).toHaveFocus();
});

it('only Done closes the dialog while the token is on screen', async () => {
  const user = userEvent.setup();
  vi.mocked(createMcpToken).mockResolvedValue(ISSUED);
  const { onClose } = renderModal();

  await settle(user.click(screen.getByRole('button', { name: 'Create token' })));
  await screen.findByText('tok-new.SECRET');

  await user.keyboard('{Escape}');
  await user.pointer({
    keys: '[MouseLeft]',
    target: document.querySelector('.cfg-modal-overlay') as HTMLElement,
  });
  expect(onClose).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: 'Done' }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('says a Write token writes only on projects with MCP write enabled', async () => {
  const user = userEvent.setup();
  renderModal();
  expect(screen.queryByText(/A write goes through only/)).not.toBeInTheDocument();

  await user.click(screen.getByRole('radio', { name: 'Write' }));

  expect(screen.getByText(/A write goes through only/)).toBeInTheDocument();
});

it('creates an API token with the chosen scopes and shows a curl example', async () => {
  const user = userEvent.setup();
  vi.mocked(createApiToken).mockResolvedValue({
    kind: 'api',
    tokenId: 'tok-api',
    token: 'tok-api.SECRET',
    scopes: ['users:read', 'users:write'],
  });
  renderModal();

  await user.click(screen.getByRole('radio', { name: 'API' }));
  expect(screen.queryByRole('radio', { name: 'Write' })).not.toBeInTheDocument();
  const createButton = screen.getByRole('button', { name: 'Create token' });
  expect(createButton).toBeDisabled();

  await user.click(screen.getByRole('checkbox', { name: /^Read users/ }));
  await user.click(screen.getByRole('checkbox', { name: /^Create, change and delete users/ }));
  await settle(user.click(createButton));

  expect(createApiToken).toHaveBeenCalledWith(['users:read', 'users:write'], '');
  expect(createMcpToken).not.toHaveBeenCalled();
  expect(await screen.findByText('tok-api.SECRET')).toBeInTheDocument();
  expect(
    screen.getByText(
      `curl -H "Authorization: Bearer tok-api.SECRET" "${window.location.origin}/api/v1/projects/<project-id>/users"`,
    ),
  ).toBeInTheDocument();
  expect(screen.queryByText('Server URL')).not.toBeInTheDocument();
  expect(screen.queryByText(/This example changes data/)).not.toBeInTheDocument();
});

it('labels the example as changing data when a users:write-only token has no read to show', async () => {
  const user = userEvent.setup();
  vi.mocked(createApiToken).mockResolvedValue({
    kind: 'api',
    tokenId: 'tok-w',
    token: 'tok-w.SECRET',
    scopes: ['users:write'],
  });
  renderModal();

  await user.click(screen.getByRole('radio', { name: 'API' }));
  await user.click(screen.getByRole('checkbox', { name: /^Create, change and delete users/ }));
  await settle(user.click(screen.getByRole('button', { name: 'Create token' })));

  expect(await screen.findByText(/-X PUT/)).toBeInTheDocument();
  expect(screen.getByText(/This example changes data/)).toBeInTheDocument();
});
