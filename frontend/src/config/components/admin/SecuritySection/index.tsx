import { useState } from 'react';
import AdminSection from '../AdminSection';
import Button from '@config/components/ui/Button';
import ChangePasswordModal from './ChangePasswordModal';

interface Props {
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<void>;
}

export default function SecuritySection({ onChangePassword }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <AdminSection title="Security">
      <p className="cfg-admin-section__desc">
        Change the device-admin password used to sign in to this manager.
      </p>
      <div>
        <Button onClick={() => setOpen(true)}>Change password</Button>
      </div>
      {open && (
        <ChangePasswordModal onChangePassword={onChangePassword} onClose={() => setOpen(false)} />
      )}
    </AdminSection>
  );
}
