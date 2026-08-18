import './projectForm.css';
import './RemoveProjectModal.css';
import { useRef, useState } from 'react';
import Button from '../../ui/Button';
import ModalShell from '../../ui/ModalShell';
import type { ProjectEntry } from '@config/store/projectsStore';
import { describeError, useProjectsStore } from '@config/store/projectsStore';

interface Props {
  entry: ProjectEntry;
  onCancel(): void;
  onRemoved(): void;
}

export default function RemoveProjectModal({ entry, onCancel, onRemoved }: Props) {
  const remove = useProjectsStore((s) => s.removeProject);
  const [deleteFolder, setDeleteFolder] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      await remove(entry.id, deleteFolder);
      onRemoved();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ModalShell
      onClose={onCancel}
      dialogClassName="name-modal cfg-flex-col"
      initialFocusRef={confirmRef}
    >
      <div className="name-modal__title">Remove “{entry.name}”?</div>
      <p className="project-form__desc">
        Removing only forgets the entry; the folder at <code>{entry.path}</code> is left on disk by
        default.
      </p>
      <label className="remove-project-modal__checkbox">
        <input
          type="checkbox"
          checked={deleteFolder}
          onChange={(e) => setDeleteFolder(e.target.checked)}
        />
        Also delete the folder on disk
      </label>
      {error && <p className="project-form__status project-form__status--error">{error}</p>}
      <div className="name-modal__actions">
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button ref={confirmRef} variant="danger" onClick={handleSubmit} disabled={submitting}>
          {submitting ? 'Removing…' : 'Remove'}
        </Button>
      </div>
    </ModalShell>
  );
}
