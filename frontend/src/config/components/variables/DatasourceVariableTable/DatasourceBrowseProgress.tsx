import type { BrowseProgress } from './useDatasourceBrowse';

interface Props {
  progress: BrowseProgress;
}

/**
 * The bar shown while Browse PLC walks the server.
 *
 * Indeterminate until the first report arrives — connecting and reading the
 * root take a moment and say nothing about size — then a percentage of the
 * work known so far, with the counts that make a long walk legible.
 */
export default function DatasourceBrowseProgress({ progress }: Props) {
  const { percent, nodes, level } = progress;
  const started = percent !== null;
  return (
    <div className="cfg-browse-progress" role="status" aria-live="polite">
      <div className="cfg-browse-progress__label">
        <span>{started ? `Browsing PLC… ${percent}%` : 'Browsing PLC…'}</span>
        {started && (
          <span className="cfg-browse-progress__detail">
            {nodes.toLocaleString()} {nodes === 1 ? 'node' : 'nodes'} · level {level}
          </span>
        )}
      </div>
      <progress
        className="cfg-browse-progress__bar"
        max={100}
        value={percent ?? undefined}
        aria-label="Browse progress"
      />
    </div>
  );
}
