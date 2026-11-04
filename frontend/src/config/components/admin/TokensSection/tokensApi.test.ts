import { createApiToken, createMcpToken, projectMcpEnabled } from './tokensApi';

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

  await createMcpToken('p1', 'read', '  ');

  expect(call()).toEqual({
    url: '/api/manager/mcp-tokens',
    body: { projectId: 'p1', access: 'read' },
  });
});

it('posts an API token as kind api with the chosen scopes', async () => {
  const call = stubFetch();

  await createApiToken('p1', ['users:read'], 'HR');

  expect(call().body).toEqual({ projectId: 'p1', kind: 'api', scopes: ['users:read'], name: 'HR' });
});

it("reads the project's MCP switch from the manager", async () => {
  const call = stubFetch({ id: 'p1', mcpEnabled: true });

  await expect(projectMcpEnabled('p1')).resolves.toBe(true);
  expect(call().url).toBe('/api/projects/p1/mcp');
});

it('answers unknown for a project the manager does not know, and throws on other failures', async () => {
  stubFetch({ detail: 'Project not found' }, 404);
  await expect(projectMcpEnabled('p1')).resolves.toBeNull();

  stubFetch({ detail: 'boom' }, 500);
  await expect(projectMcpEnabled('p1')).rejects.toThrow('boom');
});
