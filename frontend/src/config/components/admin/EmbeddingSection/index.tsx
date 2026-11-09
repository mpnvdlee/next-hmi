import { useCallback, useEffect, useState } from 'react';
import AdminSection from '../AdminSection';
import Button from '../../ui/Button';
import { describeError } from '@config/store/projectsStore';
import { getEmbeddingOrigins, saveEmbeddingOrigins } from './embeddingApi';
import './style.css';

/**
 * The other sites allowed to show the dashboard, editor and screens in a
 * frame, on the manager's Settings page. Each change saves straight away and
 * applies to the next page load; the backend refuses an entry that is not a
 * bare `scheme://host[:port]`.
 */
export default function EmbeddingSection() {
  const [origins, setOrigins] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  // One save at a time: each one is built from the list as it stands, so a
  // second click before the first lands would undo it.
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setOrigins(await getEmbeddingOrigins());
    } catch (e) {
      setError(describeError(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(next: string[]): Promise<boolean> {
    setSaving(true);
    setError(null);
    try {
      setOrigins(await saveEmbeddingOrigins(next));
      return true;
    } catch (e) {
      setError(describeError(e));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function add() {
    const text = draft.trim();
    if (!text || saving) return;
    // The typed text stays on a refusal, so it can be corrected.
    if (await save([...origins, text])) setDraft('');
  }

  return (
    <AdminSection title="Sites that may embed NEXT HMI">
      <p className="cfg-admin-section__desc cfg-admin-section__desc--wide">
        By default no other site can show these screens in a frame. Add a site only if it must show
        NEXT HMI inside its own page, such as a plant portal.
      </p>

      {error && <p className="cfg-error-banner">{error}</p>}

      {origins.length === 0 ? (
        <p className="cfg-empty">No sites listed.</p>
      ) : (
        <table className="cfg-admin-table">
          <tbody>
            {origins.map((origin) => (
              <tr key={origin}>
                <td>{origin}</td>
                <td className="cfg-admin-table__actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={saving}
                    aria-label={`Remove ${origin}`}
                    onClick={() => void save(origins.filter((o) => o !== origin))}
                  >
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="cfg-embedding__add">
        <input
          className="cfg-prop-input"
          value={draft}
          placeholder="https://portal.example.com"
          aria-label="Site to add"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add();
          }}
        />
        <Button onClick={() => void add()} disabled={saving || !draft.trim()}>
          Add site
        </Button>
      </div>
    </AdminSection>
  );
}
