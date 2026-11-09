import './projectForm.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import Button from '../../ui/Button';
import ModalShell from '../../ui/ModalShell';
import DirectoryBrowserModal from './DirectoryBrowserModalLazy';
import ProjectCodeWarning from './ProjectCodeWarning';
import {
  describeError,
  ProjectCodeUnconfirmedError,
  ProjectIdCaseConflictError,
  type ProjectCode,
  useProjectsStore,
} from '@config/store/projectsStore';
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
  // Set once the server has refused the archive for carrying code.
  const [code, setCode] = useState<ProjectCode | null>(null);
  const [trusted, setTrusted] = useState(false);
  // Set once the server has refused the archive's id as a case variant of a
  // registered one, and offered this free id instead.
  const [suggestedId, setSuggestedId] = useState<string | null>(null);
  // The id the archive is imported under once the operator took the offer.
  const [projectId, setProjectId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const suggested = useMemo(() => suggestPath(defaultRoot, file), [defaultRoot, file]);
  useEffect(() => {
    if (!pathTouched) setPath(suggested);
  }, [suggested, pathTouched]);

  const validation = useDestinationPathValidation(path);

  const ready =
    !!file &&
    path.trim().length > 0 &&
    validation?.ok === true &&
    (code === null || trusted) &&
    !submitting;
  // The same id would only be refused again.
  const canSubmit = ready && suggestedId === null;

  async function submit(id: string | null) {
    if (!file) return;
    setSubmitting(true);
    setError(null);
    setSuggestedId(null);
    try {
      await importProject(file, path.trim(), trusted, id ?? undefined);
      onImported();
    } catch (e) {
      if (e instanceof ProjectCodeUnconfirmedError) setCode(e.projectCode);
      else if (e instanceof ProjectIdCaseConflictError) {
        setError(e.message);
        setSuggestedId(e.suggestedId);
      } else setError(describeError(e));
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmit() {
    if (canSubmit) void submit(projectId);
  }

  function acceptSuggestion(id: string) {
    setProjectId(id);
    void submit(id);
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
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setCode(null);
            setTrusted(false);
            setError(null);
            setSuggestedId(null);
            setProjectId(null);
          }}
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
      {suggestedId && (
        <div className="project-form__row">
          <Button size="sm" disabled={!ready} onClick={() => acceptSuggestion(suggestedId)}>
            Use {suggestedId} instead
          </Button>
        </div>
      )}
      {projectId && !suggestedId && (
        <p className="project-form__hint">Imports under the project id {projectId}.</p>
      )}

      {code && (
        <ProjectCodeWarning
          code={code}
          unknownLead="This project contains code."
          closing="Only import projects from a source you trust."
          checked={trusted}
          disabled={submitting}
          onChange={setTrusted}
        />
      )}

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
