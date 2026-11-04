import { createApiToken, createMcpToken } from './tokensApi';

function stubFetch(body: unknown = {}, status = 200) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: status < 400,
    status,
    json: async () => body,
  }));
  vi.stubGlobal('fetch', fetchMock);
  const call = (i = 0) => ({
    url: fetchMock.mock.calls[i]?.[0],
    body: JSON.parse((fetchMock.mock.calls[i]?.[1]?.body as string | undefined) ?? 'null'),
  });
  return call;
}

beforeEach(() => {
  // The editor's own base; manager routes must not carry it.
  window.__NEXTHMI_BASE__ = '/editor/p1/';
});

afterEach(() => {
  delete window.__NEXTHMI_BASE__;
  vi.unstubAllGlobals();
});

it('posts an MCP token to the manager and leaves a blank name to the server default', async () => {
  const call = stubFetch();

  await createMcpToken('read', '  ');

  expect(call()).toEqual({ url: '/api/manager/mcp-tokens', body: { access: 'read' } });
});

it('posts an API token as kind api with the chosen scopes', async () => {
  const call = stubFetch();

  await createApiToken(['users:read'], 'HR');

  expect(call().body).toEqual({ kind: 'api', scopes: ['users:read'], name: 'HR' });
});
