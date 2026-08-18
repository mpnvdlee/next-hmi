import { useRef, useState } from 'react';
import Button from '@config/components/ui/Button';
import ModalShell from '@config/components/ui/ModalShell';
import { describeError } from '@config/store/projectsStore';
import './style.css';

interface Props {
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  onClose: () => void;
}

export default function ChangePasswordModal({ onChangePassword, onClose }: Props) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentRef = useRef<HTMLInputElement>(null);

  async function handleSubmit() {
    setError(null);
    if (next !== confirm) {
      setError('New passwords do not match');
      return;
    }
    setBusy(true);
    try {
      await onChangePassword(current, next);
      onClose();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Enter') void handleSubmit();
  }

  const canSubmit = !busy && !!current && !!next && !!confirm;

  return (
    <ModalShell
      onClose={onClose}
      dialogClassName="name-modal cfg-flex-col"
      initialFocusRef={currentRef}
    >
      <div className="name-modal__title">Change password</div>
      <div className="cfg-security-form">
        <label className="project-form__field">
          <span className="project-form__label">Current password</span>
          <input
            ref={currentRef}
            type="password"
            className="cfg-prop-input cfg-prop-input--tall"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </label>
        <label className="project-form__field">
          <span className="project-form__label">New password</span>
          <input
            type="password"
            className="cfg-prop-input cfg-prop-input--tall"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </label>
        <label className="project-form__field">
          <span className="project-form__label">Confirm new password</span>
          <input
            type="password"
            className="cfg-prop-input cfg-prop-input--tall"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </label>
        {error && <p className="project-form__status project-form__status--error">{error}</p>}
      </div>
      <div className="name-modal__actions">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void handleSubmit()} disabled={!canSubmit}>
          {busy ? 'Changing…' : 'Change password'}
        </Button>
      </div>
    </ModalShell>
  );
}
