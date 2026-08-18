import './projectForm.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import Button from '../../ui/Button';
import ModalShell from '../../ui/ModalShell';
import DirectoryBrowserModal from './DirectoryBrowserModalLazy';
import { describeError, useProjectsStore } from '@config/store/projectsStore';
import type { ProjectEntry } from '@config/store/projectsStore';
import { joinPath, slugify } from '@shared/utils/paths';
import { useDestinationPathValidation } from '../useDestinationPathValidation';

interface Props {
  defaultRoot: string | null;
  onCancel(): void;
  onCreated(entry: ProjectEntry): void;
}

export default function CreateProjectModal({ defaultRoot, onCancel, onCreated }: Props) {
  const create = useProjectsStore((s) => s.createProject);

  const [name, setName] = useState('');
  const [parentFolder, setParentFolder] = useState(defaultRoot ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (defaultRoot && !parentFolder) setParentFolder(defaultRoot);
  }, [defaultRoot, parentFolder]);

  const slug = useMemo(() => slugify(name), [name]);
  const fullPath = useMemo(() => joinPath(parentFolder.trim(), slug), [parentFolder, slug]);
  const validation = useDestinationPathValidation(fullPath, {
    createdMessage: 'Folder will be created.',
    missingReason: 'invalid',
    formatReason: humanizeReason,
  });

  const canSubmit =
    name.trim().length > 0 &&
    parentFolder.trim().length > 0 &&
    slug.length > 0 &&
    validation?.ok === true &&
    !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const entry = await create(name.trim(), fullPath);
      onCreated(entry);
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
      <div className="name-modal__title">New project</div>

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
      </label>

      <label className="project-form__field">
        <span className="project-form__label">Parent folder</span>
        <div className="project-form__row">
          <input
            type="text"
            className="cfg-prop-input cfg-prop-input--tall"
            value={parentFolder}
            onChange={(e) => setParentFolder(e.target.value)}
            placeholder={defaultRoot ?? '/absolute/path/to/parent'}
            spellCheck={false}
            autoCorrect="off"
          />
          <Button variant="ghost" disabled={submitting} onClick={() => setBrowsing(true)}>
            Browse…
          </Button>
        </div>
        <span className="project-form__hint">
          The project folder will be created inside this directory, named after the project.
        </span>
      </label>

      {browsing && (
        <DirectoryBrowserModal
          initialPath={parentFolder || defaultRoot}
          onCancel={() => setBrowsing(false)}
          onSelect={(path) => {
            setParentFolder(path);
            setBrowsing(false);
          }}
        />
      )}

      <div className="project-form__preview">
        <span className="project-form__preview-label">Project folder</span>
        <span
          className={
            'project-form__preview-path' + (fullPath ? '' : ' project-form__preview-path--empty')
          }
        >
          {fullPath || 'Enter a project name and parent folder to preview the path.'}
        </span>
      </div>

      {validation && (
        <p
          className={'project-form__status' + (validation.ok ? '' : ' project-form__status--error')}
        >
          {validation.message}
        </p>
      )}
      {error && <p className="project-form__status project-form__status--error">{error}</p>}

      <div className="name-modal__actions">
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button variant="primary" onClick={handleSubmit} disabled={!canSubmit}>
          {submitting ? 'Creating…' : 'Create'}
        </Button>
      </div>
    </ModalShell>
  );
}

function humanizeReason(reason: string): string {
  switch (reason) {
    case 'path-is-file':
      return 'A file already exists at that path.';
    case 'parent-missing':
      return "The parent folder doesn't exist.";
    case 'parent-not-writable':
      return 'The parent folder is not writable.';
    case 'not-readable':
      return 'Cannot read the destination.';
    default:
      return reason;
  }
}
