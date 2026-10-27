import { Ruler } from '@phosphor-icons/react';
import type { KeyboardEvent } from 'react';
import {
  CUSTOM_VIEWPORT,
  VIEWPORTS,
  clampViewportSide,
  type ViewportChoice,
} from './viewportPresets';

export default function ViewportSelector({
  viewport,
  onChange,
}: {
  viewport: ViewportChoice;
  onChange: (viewport: ViewportChoice) => void;
}) {
  const buttons = [...VIEWPORTS, { label: 'Custom size', icon: Ruler }];

  // Uncontrolled and committed on blur/Enter, so a half-typed "1" doesn't
  // shrink the preview to the minimum width mid-keystroke.
  const sizeInput = (side: 'w' | 'h', label: string) => {
    const commit = (raw: string) => {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed)) onChange({ ...viewport, [side]: clampViewportSide(parsed) });
    };
    return (
      <label className="editor-preview-toolbar__label">
        {label}
        <input
          key={viewport[side]}
          type="number"
          min={1}
          step={1}
          className="editor-preview-toolbar__size-input cfg-prop-input cfg-prop-input--tall cfg-header-control"
          defaultValue={viewport[side]}
          onBlur={(e) => {
            commit(e.currentTarget.value);
            e.currentTarget.value = String(viewport[side]);
          }}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Escape') e.currentTarget.value = String(viewport[side]);
            if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
          }}
          aria-label={`Viewport ${label.toLowerCase()} in pixels`}
        />
      </label>
    );
  };

  return (
    <>
      <span className="editor-preview-toolbar__label">Viewport</span>
      <div
        className="editor-preview-toolbar__seg cfg-header-control"
        role="group"
        aria-label="Viewport"
      >
        {buttons.map((v, i) => {
          const VpIcon = v.icon;
          const active = viewport.idx === i;
          return (
            <button
              key={v.label}
              type="button"
              className={`editor-preview-toolbar__seg-btn${
                active ? ' editor-preview-toolbar__seg-btn--active' : ''
              }`}
              onClick={() => onChange({ ...viewport, idx: i })}
              aria-pressed={active}
              title={v.label}
            >
              <VpIcon size={16} weight="regular" />
            </button>
          );
        })}
      </div>
      {viewport.idx === CUSTOM_VIEWPORT && (
        <>
          {sizeInput('w', 'Width')}
          {sizeInput('h', 'Height')}
        </>
      )}
    </>
  );
}
