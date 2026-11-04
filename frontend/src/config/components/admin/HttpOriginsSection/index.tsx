import { useState } from 'react';
import AdminSection from '../AdminSection';
import Button from '../../ui/Button';
import './style.css';

interface Props {
  origins: string[];
  error: string | null;
  /** Resolves `true` once the backend stored the list. */
  onSave(origins: string[]): Promise<boolean>;
}

/**
 * The origins a `$http` source with a placeholder in its host may reach
 * (`httpAllowedOrigins`, see backend/core/http_origins.py). Each change saves
 * straight away; the backend normalises and refuses entries it will not reach.
 */
export default function HttpOriginsSection({ origins, error, onSave }: Props) {
  const [draft, setDraft] = useState('');
  // One save at a time: each one is built from the list as it stands, so a
  // second click before the first lands would undo it.
  const [saving, setSaving] = useState(false);

  async function save(next: string[]): Promise<boolean> {
    setSaving(true);
    try {
      return await onSave(next);
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
    <AdminSection title="HTTP sources">
      <p className="cfg-admin-section__desc cfg-admin-section__desc--wide">
        An <code>$http</code> source whose url takes its host from a placeholder, such as{' '}
        <code>{'http://{host}/api'}</code>, can only reach the origins listed here: scheme, host and
        port. Sources with a fixed host need no entry. This machine itself is never allowed.
      </p>

      {error && <p className="cfg-error-banner">{error}</p>}

      {origins.length === 0 ? (
        <p className="cfg-empty">No origins listed.</p>
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

      <div className="cfg-http-origins__add">
        <input
          className="cfg-prop-input"
          value={draft}
          placeholder="Add an origin, e.g. http://10.0.0.5:8080"
          aria-label="Origin to add"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add();
          }}
        />
        <Button onClick={() => void add()} disabled={saving || !draft.trim()}>
          Add
        </Button>
      </div>
    </AdminSection>
  );
}
