import { CaretRight, House } from '@phosphor-icons/react';

/**
 * Explorer-style breadcrumb for drill-down folder browsing in the asset pickers.
 * Renders "Home / segment / segment" with each crumb clickable to jump there.
 */
export default function FolderBreadcrumb({
  folder,
  onNavigate,
}: {
  folder: string;
  onNavigate: (folder: string) => void;
}) {
  const segments = folder ? folder.split('/') : [];

  return (
    <div className="cfg-asset-picker-breadcrumb">
      <button
        type="button"
        className="cfg-asset-picker-breadcrumb__crumb"
        onClick={() => onNavigate('')}
      >
        <House size={13} weight={folder ? 'regular' : 'fill'} />
        <span>Home</span>
      </button>
      {segments.map((seg, i) => {
        const path = segments.slice(0, i + 1).join('/');
        const isLast = i === segments.length - 1;
        return (
          <span key={path} className="cfg-asset-picker-breadcrumb__item">
            <CaretRight size={11} className="cfg-asset-picker-breadcrumb__sep" />
            <button
              type="button"
              className={`cfg-asset-picker-breadcrumb__crumb${isLast ? ' cfg-asset-picker-breadcrumb__crumb--current' : ''}`}
              onClick={() => onNavigate(path)}
              disabled={isLast}
            >
              {seg}
            </button>
          </span>
        );
      })}
    </div>
  );
}
