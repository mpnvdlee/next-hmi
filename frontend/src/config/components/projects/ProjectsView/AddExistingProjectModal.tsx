import './projectForm.css';
import { useEffect, useRef, useState } from 'react';
import Button from '../../ui/Button';
import ModalShell from '../../ui/ModalShell';
import DirectoryBrowserModal from './DirectoryBrowserModalLazy';
import { describeError, useProjectsStore } from '@config/store/projectsStore';
import { pathSeparator } from '@shared/utils/paths';

interface Props {
  defaultRoot: string | null;
  onCancel(): void;
  onAdded(): void;
}

export default function AddExistingProjectModal({ defaultRoot, onCancel, onAdded }: Props) {
  const register = useProjectsStore((s) => s.registerExisting);
  const validate = useProjectsStore((s) => s.validatePath);
  const browseDir = useProjectsStore((s) => s.browseDir);
  const [path, setPath] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [pickerHint, setPickerHint] = useState<{ ok: boolean; message: string } | null>(null);
  const [pathStatus, setPathStatus] = useState<
    { kind: 'idle' } | { kind: 'ok' } | { kind: 'error'; message: string }
  >({ kind: 'idle' });
  const pathRef = useRef<HTMLInputElement>(null);

  // Pre-fill the parent half of the path with the runtime's default root so the
  // common case (project already lives under defaultRoot) is one click away.
  useEffect(() => {
    if (defaultRoot && !path) setPath(defaultRoot + pathSeparator(defaultRoot));
  }, [defaultRoot, path]);

  // Debounced check that the typed path is an existing directory. The
  // OS-picker pre-fill can produce non-existent paths (browsers don't expose
  // absolute paths), so catching that early is much friendlier than waiting
  // for the submit to fail.
  useEffect(() => {
    const trimmed = path.trim();
    if (!trimmed || (defaultRoot && trimmed === defaultRoot + pathSeparator(defaultRoot))) {
      setPathStatus({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      const res = await validate(trimmed);
      if (cancelled) return;
      if (!res.ok || !res.exists) {
        setPathStatus({ kind: 'error', message: "Folder doesn't exist on disk." });
        return;
      }
      setPathStatus({ kind: 'ok' });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [path, defaultRoot, validate]);

  async function handleFolderPicked(picked: string) {
    setPath(picked);
    setBrowsing(false);
    const folderName = picked.split(pathSeparator(picked)).filter(Boolean).pop() ?? picked;
    try {
      const res = await browseDir(picked);
      setPickerHint(
        res.hasConfigJson
          ? { ok: true, message: `Selected folder "${folderName}" contains config.json.` }
          : {
              ok: false,
              message: `Selected "${folderName}", but it doesn't appear to contain config.json. Adjust the path if needed.`,
            },
      );
    } catch {
      setPickerHint(null);
    }
  }

  async function handleSubmit() {
    const trimmed = path.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setError(null);
    try {
      await register(trimmed);
      onAdded();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit = path.trim().length > 0 && pathStatus.kind !== 'error' && !submitting;

  return (
    <ModalShell
      onClose={onCancel}
      dialogClassName="name-modal cfg-flex-col"
      initialFocusRef={pathRef}
    >
      <div className="name-modal__title">Add existing project</div>
      <p className="project-form__desc">
        Point at a project folder that already contains <code>config.json</code> with a{' '}
        <code>project</code> block. The project is added to the manifest but not made live.
      </p>

      <label className="project-form__field">
        <span className="project-form__label">Project folder</span>
        <div className="project-form__row">
          <input
            ref={pathRef}
            type="text"
            className="cfg-prop-input cfg-prop-input--tall"
            value={path}
            onChange={(e) => {
              setPath(e.target.value);
              setPickerHint(null);
            }}
            placeholder={defaultRoot ? `${defaultRoot}/my-project` : '/absolute/path/to/project'}
            spellCheck={false}
            autoCorrect="off"
          />
          <Button variant="ghost" disabled={submitting} onClick={() => setBrowsing(true)}>
            Browse…
          </Button>
        </div>
      </label>

      {browsing && (
        <DirectoryBrowserModal
          initialPath={path || defaultRoot}
          onCancel={() => setBrowsing(false)}
          onSelect={(picked) => void handleFolderPicked(picked)}
        />
      )}

      {pickerHint && (
        <p
          className={'project-form__status' + (pickerHint.ok ? '' : ' project-form__status--error')}
        >
          {pickerHint.message}
        </p>
      )}

      {pathStatus.kind === 'error' && (
        <p className="project-form__status project-form__status--error">{pathStatus.message}</p>
      )}

      {error && <p className="project-form__status project-form__status--error">{error}</p>}

      <div className="name-modal__actions">
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button variant="primary" onClick={handleSubmit} disabled={!canSubmit}>
          {submitting ? 'Adding…' : 'Add project'}
        </Button>
      </div>
    </ModalShell>
  );
}
