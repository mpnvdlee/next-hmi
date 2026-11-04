import { managerApiJson } from '@shared/utils/api';

/**
 * The manager's token routes (`/api/manager/mcp-tokens`, gated by the manager
 * session). They live at the origin root, not under `/editor/<slug>/`, hence
 * `managerApiJson`.
 */

export type McpAccess = 'read' | 'write';

/** What an API v1 token may do; `backend/core/mcp_tokens.py` API_SCOPES. */
export type ApiScope =
  'history:read' | 'alarms:read' | 'recipes:read' | 'users:read' | 'users:write' | 'sessions:write';

/** One row of `GET /api/manager/mcp-tokens`: an MCP token has `access`, an API token `scopes`. */
export interface ListedToken {
  id: string;
  kind: 'mcp' | 'api';
  name: string;
  access?: McpAccess;
  scopes?: ApiScope[];
  createdAt: string;
}

/** `POST /api/manager/mcp-tokens` — the only response that carries the secret. */
export interface IssuedMcpToken {
  kind: 'mcp';
  tokenId: string;
  token: string;
  access: McpAccess;
  transport: string;
}

export interface IssuedApiToken {
  kind: 'api';
  tokenId: string;
  token: string;
  scopes: ApiScope[];
}

export const listTokens = async () =>
  (await managerApiJson<{ tokens: ListedToken[] }>('/api/manager/mcp-tokens')).tokens;

/** A token covers every project; the body names none. */
export const createMcpToken = (access: McpAccess, name: string) =>
  managerApiJson<IssuedMcpToken>('/api/manager/mcp-tokens', {
    method: 'POST',
    body: { access, name: name.trim() || undefined },
  });

export const createApiToken = (scopes: ApiScope[], name: string) =>
  managerApiJson<IssuedApiToken>('/api/manager/mcp-tokens', {
    method: 'POST',
    body: { kind: 'api', scopes, name: name.trim() || undefined },
  });

export async function revokeToken(tokenId: string) {
  await managerApiJson(`/api/manager/mcp-tokens/${encodeURIComponent(tokenId)}`, {
    method: 'DELETE',
  });
}
