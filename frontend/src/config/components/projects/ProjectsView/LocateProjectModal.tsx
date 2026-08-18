import './projectForm.css';
import { useEffect, useRef, useState } from 'react';
import Button from '../../ui/Button';
import ModalShell from '../../ui/ModalShell';
import DirectoryBrowserModal from './DirectoryBrowserModalLazy';
import { describeError, useProjectsStore, type ProjectEntry } from '@config/store/projectsStore';
import { pathSeparator } from '@shared/utils/paths';

interface Props {
  entry: ProjectEntry;
  defaultRoot: string | null;
  onCancel(): void;
  onLocated(): void;
}

/**
 * Re-point a manifest entry whose folder moved. The backend refuses a folder
 * whose embedded project id differs, so a mistyped path can't silently attach
 * this entry to an unrelated tree — the check here is only about failing fast
 * and readably before the submit.
 */
export default function LocateProjectModal({ entry, defaultRoot, onCancel, onLocated }: Props) {
  const locate = useProjectsStore((s) => s.locate);
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

  useEffect(() => {
    const trimmed = path.trim();
    if (!trimmed) {
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
  }, [path, validate]);

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
      await locate(entry.id, trimmed);
      onLocated();
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
      <div className="name-modal__title">Locate “{entry.name}”</div>
      <p className="project-form__desc">
        The folder recorded for this project is missing:
        <br />
        <code>{entry.path}</code>
        <br />
        Point at its new location. The folder must hold the same project id, so this can only
        re-point the entry — never adopt a different project.
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
          {submitting ? 'Locating…' : 'Locate'}
        </Button>
      </div>
    </ModalShell>
  );
}
