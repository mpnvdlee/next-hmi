import { useCallback, useEffect, useState } from 'react';
import AdminSection from '../AdminSection';
import Button from '../../ui/Button';
import AccessBadge from '../../ui/AccessBadge';
import { describeError } from '@config/store/projectsStore';
import CreateTokenModal from './CreateTokenModal';
import { listTokens, projectMcpEnabled, revokeToken, type ListedToken } from './tokensApi';
import './style.css';

interface Props {
  projectId: string;
}

/**
 * The bearer tokens scoped to this project: MCP tokens for AI clients and API
 * tokens for API v1 integrations. Listed and revoked here; created and shown
 * once in {@link CreateTokenModal}.
 */
export default function TokensSection({ projectId }: Props) {
  const [tokens, setTokens] = useState<ListedToken[]>([]);
  const [mcpEnabled, setMcpEnabled] = useState<boolean | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const all = await listTokens();
      setTokens(all.filter((t) => t.projectId === projectId));
    } catch (e) {
      setError(describeError(e));
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function openCreate() {
    // Read at open time: the switch lives on the dashboard and may have just changed.
    setError(null);
    try {
      setMcpEnabled(await projectMcpEnabled(projectId));
    } catch (e) {
      setError(describeError(e));
      setMcpEnabled(null);
    }
    setCreating(true);
  }

  async function revoke(id: string) {
    setBusy(true);
    setError(null);
    try {
      await revokeToken(id);
      await refresh();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AdminSection
      title="Tokens"
      actions={<Button onClick={() => void openCreate()}>Create token</Button>}
    >
      <p className="cfg-admin-section__desc cfg-admin-section__desc--wide">
        A token lets an AI client (MCP) or an integration such as an MES or HR system (API v1) reach
        this project without the device-admin password. Revoke a token to cut that access off.
      </p>

      {error && <p className="cfg-error-banner">{error}</p>}

      {tokens.length === 0 ? (
        <p className="cfg-empty">No tokens yet.</p>
      ) : (
        <table className="cfg-admin-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Access</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => {
              const created = new Date(t.createdAt).toLocaleString();
              return (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>{t.kind === 'api' ? 'API' : 'MCP'}</td>
                  <td>
                    {t.kind === 'api' ? (
                      <code className="cfg-tokens__scopes">{t.scopes?.join(', ')}</code>
                    ) : (
                      <AccessBadge
                        writable={t.access === 'write'}
                        readOnlyLabel="Read"
                        readWriteLabel="Write"
                      />
                    )}
                  </td>
                  <td>{created}</td>
                  <td className="cfg-admin-table__actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      aria-label={`Revoke ${t.name}, created ${created}`}
                      onClick={() => void revoke(t.id)}
                    >
                      Revoke
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {creating && (
        <CreateTokenModal
          projectId={projectId}
          mcpEnabled={mcpEnabled}
          onCreated={() => void refresh()}
          onClose={() => setCreating(false)}
        />
      )}
    </AdminSection>
  );
}
