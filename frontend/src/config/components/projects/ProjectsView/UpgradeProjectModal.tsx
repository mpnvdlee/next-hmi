import { useRef, useState } from 'react';
import Button from '../../ui/Button';
import ModalShell from '../../ui/ModalShell';
import type { ProjectEntry, ProjectMigrationRecord } from '@config/store/projectsStore';
import { describeError, useProjectsStore } from '@config/store/projectsStore';

interface Props {
  entry: ProjectEntry;
  onCancel(): void;
  /** Called once the upgrade has actually happened, with what changed — the
   * caller decides how (or whether) to acknowledge it; this modal doesn't
   * keep the notice around itself. `null` if the reload raced and the fresh
   * record wasn't there yet. */
  onUpgraded(migration: ProjectMigrationRecord | null): void;
  /** The manager's `start` action — passed in rather than read from
   * `managerStore` directly, since this component lives under `@config`
   * alongside the sibling project modals and none of them reach into the
   * manager-only store. */
  start(id: string, opts?: { confirmUpgrade?: boolean }): Promise<void>;
}

export default function UpgradeProjectModal({ entry, onCancel, onUpgraded, start }: Props) {
  const loadProjects = useProjectsStore((s) => s.load);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  async function handleUpgrade() {
    setSubmitting(true);
    setError(null);
    try {
      await start(entry.id, { confirmUpgrade: true });
      await loadProjects();
      const updated = useProjectsStore.getState().projects.find((p) => p.id === entry.id);
      onUpgraded(updated?.lastMigration ?? null);
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
      <div className="name-modal__title">Upgrade “{entry.name}”?</div>
      <p className="project-form__desc">
        This build needs to upgrade this project's file format before it can start.
      </p>
      <p className="project-form__desc">
        Your project files are backed up automatically before anything changes.
      </p>
      {error && <p className="project-form__status project-form__status--error">{error}</p>}
      <div className="name-modal__actions">
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button ref={confirmRef} variant="primary" onClick={handleUpgrade} disabled={submitting}>
          {submitting ? 'Upgrading…' : 'Upgrade & start'}
        </Button>
      </div>
    </ModalShell>
  );
}
