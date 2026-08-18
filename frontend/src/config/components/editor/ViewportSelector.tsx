import { VIEWPORTS } from './viewportPresets';

export default function ViewportSelector({
  vpIdx,
  onChange,
}: {
  vpIdx: number;
  onChange: (index: number) => void;
}) {
  return (
    <>
      <span className="editor-preview-toolbar__label">Viewport</span>
      <div
        className="editor-preview-toolbar__seg cfg-header-control"
        role="group"
        aria-label="Viewport"
      >
        {VIEWPORTS.map((v, i) => {
          const VpIcon = v.icon;
          const active = vpIdx === i;
          return (
            <button
              key={v.label}
              type="button"
              className={`editor-preview-toolbar__seg-btn${
                active ? ' editor-preview-toolbar__seg-btn--active' : ''
              }`}
              onClick={() => onChange(i)}
              aria-pressed={active}
              title={v.label}
            >
              <VpIcon size={16} weight="regular" />
            </button>
          );
        })}
      </div>
    </>
  );
}
