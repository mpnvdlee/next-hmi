import { isApiError, managerApiJson } from '@shared/utils/api';

/**
 * The manager's token routes (`/api/manager/mcp-tokens`, gated by the manager
 * session). They live at the origin root, not under `/editor/<slug>/`, hence
 * `managerApiJson`.
 */

export type McpAccess = 'read' | 'write';

/** What an API v1 token may do; `backend/core/mcp_tokens.py` API_SCOPES. */
export type ApiScope =
  'history:read' | 'alarms:read' | 'recipes:read' | 'users:read' | 'users:write';

/** One row of `GET /api/manager/mcp-tokens`: an MCP token has `access`, an API token `scopes`. */
export interface ListedToken {
  id: string;
  kind: 'mcp' | 'api';
  name: string;
  projectId: string;
  access?: McpAccess;
  scopes?: ApiScope[];
  createdAt: string;
}

/** `POST /api/manager/mcp-tokens` — the only response that carries the secret. */
export interface IssuedMcpToken {
  kind: 'mcp';
  tokenId: string;
  token: string;
  projectId: string;
  access: McpAccess;
  transport: string;
}

export interface IssuedApiToken {
  kind: 'api';
  tokenId: string;
  token: string;
  projectId: string;
  scopes: ApiScope[];
}

export const listTokens = async () =>
  (await managerApiJson<{ tokens: ListedToken[] }>('/api/manager/mcp-tokens')).tokens;

export const createMcpToken = (projectId: string, access: McpAccess, name: string) =>
  managerApiJson<IssuedMcpToken>('/api/manager/mcp-tokens', {
    method: 'POST',
    body: { projectId, access, name: name.trim() || undefined },
  });

export const createApiToken = (projectId: string, scopes: ApiScope[], name: string) =>
  managerApiJson<IssuedApiToken>('/api/manager/mcp-tokens', {
    method: 'POST',
    body: { projectId, kind: 'api', scopes, name: name.trim() || undefined },
  });

export async function revokeToken(tokenId: string) {
  await managerApiJson(`/api/manager/mcp-tokens/${encodeURIComponent(tokenId)}`, {
    method: 'DELETE',
  });
}

/** The project's MCP write switch; `null` when the manager does not know the project (404). */
export async function projectMcpEnabled(projectId: string): Promise<boolean | null> {
  try {
    const { mcpEnabled } = await managerApiJson<{ mcpEnabled: boolean }>(
      `/api/projects/${encodeURIComponent(projectId)}/mcp`,
    );
    return mcpEnabled;
  } catch (e) {
    if (isApiError(e) && e.status === 404) return null;
    throw e;
  }
}
