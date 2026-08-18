import './projectForm.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import Button from '../../ui/Button';
import ModalShell from '../../ui/ModalShell';
import DirectoryBrowserModal from './DirectoryBrowserModalLazy';
import { describeError, useProjectsStore } from '@config/store/projectsStore';
import { joinPath, slugify } from '@shared/utils/paths';
import { useDestinationPathValidation } from '../useDestinationPathValidation';

interface Props {
  defaultRoot: string | null;
  onCancel(): void;
  onImported(): void;
}

function suggestPath(root: string | null, file: File | null): string {
  if (!root || !file) return '';
  const base = file.name.replace(/\.nexthmi\.zip$/i, '').replace(/\.zip$/i, '');
  const slug = slugify(base);
  if (!slug) return '';
  return joinPath(root, slug);
}

export default function ImportProjectModal({ defaultRoot, onCancel, onImported }: Props) {
  const importProject = useProjectsStore((s) => s.importProject);

  const [file, setFile] = useState<File | null>(null);
  const [path, setPath] = useState('');
  const [pathTouched, setPathTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const suggested = useMemo(() => suggestPath(defaultRoot, file), [defaultRoot, file]);
  useEffect(() => {
    if (!pathTouched) setPath(suggested);
  }, [suggested, pathTouched]);

  const validation = useDestinationPathValidation(path);

  const canSubmit = !!file && path.trim().length > 0 && validation?.ok === true && !submitting;

  async function handleSubmit() {
    if (!canSubmit || !file) return;
    setSubmitting(true);
    setError(null);
    try {
      await importProject(file, path.trim());
      onImported();
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
      initialFocusRef={fileRef}
    >
      <div className="name-modal__title">Import project from zip</div>

      <label className="project-form__field">
        <span className="project-form__label">Zip file</span>
        <input
          ref={fileRef}
          type="file"
          accept=".zip,application/zip"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>

      <label className="project-form__field">
        <span className="project-form__label">Destination folder</span>
        <div className="project-form__row">
          <input
            type="text"
            className="cfg-prop-input cfg-prop-input--tall"
            value={path}
            onChange={(e) => {
              setPath(e.target.value);
              setPathTouched(true);
            }}
            placeholder={defaultRoot ? `${defaultRoot}/…` : '/absolute/path/to/destination'}
            spellCheck={false}
            autoCorrect="off"
          />
          <Button variant="ghost" disabled={submitting} onClick={() => setBrowsing(true)}>
            Browse…
          </Button>
        </div>
        <span className="project-form__hint">
          Where the imported project will be unpacked. Must be empty or non-existent.
        </span>
      </label>

      {browsing && (
        <DirectoryBrowserModal
          initialPath={path || defaultRoot}
          onCancel={() => setBrowsing(false)}
          onSelect={(picked) => {
            const base = file
              ? slugify(file.name.replace(/\.nexthmi\.zip$/i, '').replace(/\.zip$/i, ''))
              : '';
            setPath(base ? joinPath(picked, base) : picked);
            setPathTouched(true);
            setBrowsing(false);
          }}
        />
      )}

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
          {submitting ? 'Importing…' : 'Import'}
        </Button>
      </div>
    </ModalShell>
  );
}
