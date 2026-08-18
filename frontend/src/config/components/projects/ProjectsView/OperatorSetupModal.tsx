import './projectForm.css';
import { useRef, useState } from 'react';
import Button from '../../ui/Button';
import ModalShell from '../../ui/ModalShell';
import type { ProjectEntry } from '@config/store/projectsStore';
import { describeError, useProjectsStore } from '@config/store/projectsStore';

interface Props {
  entry: ProjectEntry;
  onCompleted(): void;
}

export default function OperatorSetupModal({ entry, onCompleted }: Props) {
  const setupOperatorPassword = useProjectsStore((s) => s.setupOperatorPassword);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const canSubmit = password.length > 0 && password === confirm && !submitting;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await setupOperatorPassword(entry.id, password);
      onCompleted();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ModalShell
      onClose={() => undefined}
      dialogClassName="name-modal cfg-flex-col"
      initialFocusRef={passwordRef}
    >
      <form className="cfg-flex-col" onSubmit={handleSubmit}>
        <div className="name-modal__title">Set operator password</div>
        <p className="project-form__desc">
          “{entry.name}” is a fresh project. Choose the password for its <strong>admin</strong>{' '}
          operator account before opening the HMI or editor. This is separate from the
          device-manager password.
        </p>
        <label className="project-form__field">
          <span className="project-form__label">Operator password</span>
          <input
            ref={passwordRef}
            type="password"
            className="cfg-prop-input cfg-prop-input--tall"
            value={password}
            autoComplete="new-password"
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <label className="project-form__field">
          <span className="project-form__label">Confirm operator password</span>
          <input
            type="password"
            className="cfg-prop-input cfg-prop-input--tall"
            value={confirm}
            autoComplete="new-password"
            onChange={(event) => setConfirm(event.target.value)}
          />
        </label>
        {confirm && password !== confirm && (
          <p className="project-form__status project-form__status--error">
            Passwords do not match.
          </p>
        )}
        {error && <p className="project-form__status project-form__status--error">{error}</p>}
        <div className="name-modal__actions">
          <Button variant="primary" type="submit" disabled={!canSubmit}>
            {submitting ? 'Saving…' : 'Set password'}
          </Button>
        </div>
      </form>
    </ModalShell>
  );
}
