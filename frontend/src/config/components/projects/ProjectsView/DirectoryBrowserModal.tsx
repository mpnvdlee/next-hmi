import './directoryBrowserModal.css';
import { useEffect, useRef, useState } from 'react';
import { ArrowUUpLeft, CaretRight, FolderSimple } from '@phosphor-icons/react';
import Button from '../../ui/Button';
import ModalShell from '../../ui/ModalShell';
import { describeError, useProjectsStore, type BrowseDirEntry } from '@config/store/projectsStore';
import { pathSeparator } from '@shared/utils/paths';

interface Props {
  initialPath?: string | null;
  onCancel(): void;
  onSelect(path: string): void;
}

function breadcrumbSegments(path: string): { label: string; path: string }[] {
  const sep = pathSeparator(path);
  const isAbsoluteUnix = sep === '/' && path.startsWith('/');
  const parts = path.split(sep).filter(Boolean);
  const segments: { label: string; path: string }[] = [];
  let acc = isAbsoluteUnix ? '' : '';
  parts.forEach((part, i) => {
    acc = isAbsoluteUnix || i > 0 ? `${acc}${sep}${part}` : part;
    segments.push({ label: part, path: acc });
  });
  if (isAbsoluteUnix) segments.unshift({ label: sep, path: sep });
  return segments;
}

/**
 * Real, backend-driven folder browser. The browser sandboxes any OS file
 * picker so no web API returns an absolute path — this instead lists real
 * directories on the machine the backend runs on via ``GET
 * /api/projects/browse-dir``, so the path it returns always exists.
 */
export default function DirectoryBrowserModal({ initialPath, onCancel, onSelect }: Props) {
  const browseDir = useProjectsStore((s) => s.browseDir);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<BrowseDirEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  function load(path?: string | null) {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    browseDir(path ?? undefined)
      .then((res) => {
        if (requestId.current !== id) return;
        setCurrentPath(res.path);
        setParentPath(res.parent);
        setEntries(res.entries);
        if (res.error) setError(res.error);
      })
      .catch((e) => {
        if (requestId.current !== id) return;
        setError(describeError(e));
      })
      .finally(() => {
        if (requestId.current === id) setLoading(false);
      });
  }

  useEffect(() => {
    load(initialPath);
    // Only run once on mount — subsequent navigation is driven by user clicks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <ModalShell onClose={onCancel} dialogClassName="name-modal cfg-flex-col directory-browser">
      <div className="name-modal__title">Choose folder</div>

      <div className="directory-browser__breadcrumb">
        {currentPath &&
          breadcrumbSegments(currentPath).map((seg, i, arr) => (
            <span className="directory-browser__crumb-group" key={seg.path}>
              <button
                type="button"
                className="directory-browser__crumb"
                disabled={i === arr.length - 1}
                onClick={() => load(seg.path)}
              >
                {seg.label}
              </button>
              {i < arr.length - 1 && (
                <CaretRight
                  className="directory-browser__crumb-sep"
                  size={11}
                  weight="bold"
                  aria-hidden="true"
                />
              )}
            </span>
          ))}
      </div>

      <div className="directory-browser__list">
        {loading && <div className="directory-browser__empty">Loading…</div>}
        {!loading && parentPath && (
          <button
            type="button"
            className="directory-browser__entry directory-browser__entry--up"
            onClick={() => load(parentPath)}
          >
            <ArrowUUpLeft size={14} weight="bold" aria-hidden="true" />
            <span>Up</span>
          </button>
        )}
        {!loading && entries.length === 0 && !parentPath && (
          <div className="directory-browser__empty">No subfolders here.</div>
        )}
        {!loading &&
          entries.map((entry) => (
            <button
              type="button"
              key={entry.path}
              className="directory-browser__entry"
              onClick={() => load(entry.path)}
            >
              <FolderSimple size={14} weight="fill" aria-hidden="true" />
              <span>{entry.name}</span>
            </button>
          ))}
      </div>

      {error && <p className="project-form__status project-form__status--error">{error}</p>}

      <div className="name-modal__actions">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!currentPath || loading}
          onClick={() => currentPath && onSelect(currentPath)}
        >
          Select this folder
        </Button>
      </div>
    </ModalShell>
  );
}
