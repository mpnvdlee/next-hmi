import { useState } from 'react';
import AdminSection from '../AdminSection';
import Button from '@config/components/ui/Button';
import { describeError } from '@config/store/projectsStore';
import ChangePasswordModal from './ChangePasswordModal';
import './style.css';

interface Props {
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  /** Ends every browser session, this one included; the app then shows sign-in. */
  onSignOutEverywhere: () => Promise<void>;
}

export default function SecuritySection({ onChangePassword, onSignOutEverywhere }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOutEverywhere() {
    setBusy(true);
    setError(null);
    try {
      await onSignOutEverywhere();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <AdminSection title="Security">
      <div className="cfg-security__part">
        <h3 className="cfg-security__heading">Device-admin password</h3>
        <p className="cfg-admin-section__desc">
          Change the device-admin password used to sign in to this manager.
        </p>
        <div className="cfg-security__row">
          <Button onClick={() => setOpen(true)}>Change password</Button>
          <span className="cfg-security__note">Changing it signs out every other browser.</span>
        </div>
      </div>
      <div className="cfg-security__part">
        <h3 className="cfg-security__heading">Sessions</h3>
        <p className="cfg-admin-section__desc cfg-admin-section__desc--wide">
          A sign-in stays valid for 24 hours, or until you sign out. Signing out everywhere ends
          every browser session on this manager, this one included. MCP and API tokens keep working.
        </p>
        <div>
          <Button variant="danger" disabled={busy} onClick={() => void signOutEverywhere()}>
            Sign out everywhere
          </Button>
        </div>
        {error && <p className="cfg-error-banner">{error}</p>}
      </div>
      {open && (
        <ChangePasswordModal onChangePassword={onChangePassword} onClose={() => setOpen(false)} />
      )}
    </AdminSection>
  );
}
