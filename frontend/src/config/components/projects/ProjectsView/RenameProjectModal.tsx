import './projectForm.css';
import { useRef, useState } from 'react';
import Button from '../../ui/Button';
import ModalShell from '../../ui/ModalShell';
import { describeError, useProjectsStore, type ProjectEntry } from '@config/store/projectsStore';
import { slugify } from '@shared/utils/paths';

interface Props {
  entry: ProjectEntry;
  onCancel(): void;
  onRenamed(): void;
}

/** Mirrors `validate_project_id` in `backend/core/manifest.py`. */
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Rename a project's display name, its id, or both. The id is the address —
 * it appears in `/runtime/<id>/` and `/editor/<id>/` URLs, in the instance log
 * folder and in MCP token scopes — so changing it invalidates bookmarks, and
 * the backend only allows it while the project is stopped.
 */
export default function RenameProjectModal({ entry, onCancel, onRenamed }: Props) {
  const renameProject = useProjectsStore((s) => s.renameProject);
  const [name, setName] = useState(entry.name);
  const [id, setId] = useState(entry.id);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const trimmedName = name.trim();
  const trimmedId = id.trim();
  const idChanged = trimmedId !== entry.id;
  const nameChanged = trimmedName !== entry.name;
  const idError =
    trimmedId.length === 0
      ? 'The project id must not be empty.'
      : !PROJECT_ID_RE.test(trimmedId)
        ? 'Use 1-128 characters: letters, digits, dot, underscore or hyphen, starting with a letter or digit.'
        : null;

  const canSubmit = trimmedName.length > 0 && !idError && (nameChanged || idChanged) && !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await renameProject(entry.id, {
        ...(nameChanged ? { name: trimmedName } : {}),
        ...(idChanged ? { id: trimmedId } : {}),
      });
      onRenamed();
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
      initialFocusRef={nameRef}
    >
      <div className="name-modal__title">Rename “{entry.name}”</div>

      <label className="project-form__field">
        <span className="project-form__label">Project name</span>
        <input
          ref={nameRef}
          type="text"
          className="cfg-prop-input cfg-prop-input--tall"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Plant A"
          spellCheck={false}
          autoCorrect="off"
        />
        <span className="project-form__hint">Shown in this list and in the project itself.</span>
      </label>

      <label className="project-form__field">
        <span className="project-form__label">Project id</span>
        <div className="project-form__row">
          <input
            type="text"
            className="cfg-prop-input cfg-prop-input--tall"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="plant-a"
            spellCheck={false}
            autoCorrect="off"
          />
          <Button
            variant="ghost"
            disabled={submitting || slugify(name).length === 0}
            onClick={() => setId(slugify(name))}
            title="Derive the id from the project name"
          >
            From name
          </Button>
        </div>
        <span className="project-form__hint">
          The address of the project. Changing it breaks existing bookmarks and any client using the
          old URL.
        </span>
      </label>

      <div className="project-form__preview">
        <span className="project-form__preview-label">Project URLs</span>
        <span
          className={
            'project-form__preview-path' + (idError ? ' project-form__preview-path--empty' : '')
          }
        >
          {idError ? 'Enter a valid project id to preview the URLs.' : `/runtime/${trimmedId}/`}
        </span>
        {!idError && <span className="project-form__preview-path">{`/editor/${trimmedId}/`}</span>}
      </div>

      {idError && <p className="project-form__status project-form__status--error">{idError}</p>}
      {!idError && idChanged && (
        <p className="project-form__status">
          The folder on disk keeps its current path — only the id in the manifest and in the
          project&rsquo;s config.json changes.
        </p>
      )}
      {error && <p className="project-form__status project-form__status--error">{error}</p>}

      <div className="name-modal__actions">
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button variant="primary" onClick={handleSubmit} disabled={!canSubmit}>
          {submitting ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </ModalShell>
  );
}
