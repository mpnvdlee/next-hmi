import './style.css';
import AdminSection from '../AdminSection';
import Button from '../../ui/Button';
import Spinner from '@shared/components/Spinner';
import type { RuntimeSession } from '../../../store/adminViewStore';

interface Props {
  runtimes: RuntimeSession[];
  loading: boolean;
  error: string | null;
  onRefresh(): void;
}

export default function ConnectedRuntimesSection({ runtimes, loading, error, onRefresh }: Props) {
  return (
    <AdminSection
      title="Connected Runtimes"
      actions={
        <Button variant="ghost" onClick={onRefresh} disabled={loading}>
          {loading ? <Spinner size="sm" variant="cfg" /> : 'Refresh'}
        </Button>
      }
    >
      {error && <p className="cfg-error-banner">{error}</p>}

      {!error && runtimes.length === 0 && <p className="cfg-empty">No active runtimes.</p>}

      {runtimes.length > 0 && (
        <table className="cfg-admin-table">
          <thead>
            <tr>
              <th>Scope</th>
              <th>Username</th>
              <th>Groups</th>
              <th>Connected since</th>
            </tr>
          </thead>
          <tbody>
            {runtimes.map((r) => (
              <tr key={`${r.clientId}-${r.scope}`}>
                <td className="cfg-runtimes-table__scope">{r.scope}</td>
                <td>{r.username}</td>
                <td>{r.groups.join(', ')}</td>
                <td className="cfg-runtimes-table__time">
                  {new Date(r.connectedAt).toLocaleTimeString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </AdminSection>
  );
}
