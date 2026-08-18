import { useRef, useState, useCallback } from 'react';
import { ClearIcon } from '@config/components/ui/actionIcons';
import AddButton from '@config/components/ui/AddButton';
import type { ImageIndicator } from '@shared/types/config';
import { slugId } from '@shared/utils/id';
import { resolveImageSrc } from '@shared/utils/imageAsset';
import { clamp01 } from '@hmi/components/ImageContainer/positions';
import ModalShell, { ModalCloseButton } from '@config/components/ui/ModalShell';
import '../markerEditor.css';
import './style.css';

interface Props {
  value: ImageIndicator[] | undefined;
  /** Raw value of the `src` property from the same component (may be `{ $static: { path } }` or string). */
  src: unknown;
  onChange: (v: ImageIndicator[]) => void;
}

interface DragTarget {
  id: string;
  part: 'circle' | 'pill';
}

export default function ImageIndicatorsEditor({ value, src, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [local, setLocal] = useState<ImageIndicator[]>([]);
  const [dragging, setDragging] = useState<DragTarget | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const imageUrl = resolveImageSrc(src);
  const indicators = Array.isArray(value) ? value : [];

  function openModal() {
    const copy = indicators.map((ind) => ({ ...ind }));
    setLocal(copy);
    setSelectedId(copy[0]?.id ?? null);
    setImgSize(null);
    setOpen(true);
  }

  function closeModal() {
    setDragging(null);
    setOpen(false);
  }

  function handleSave() {
    onChange(local);
    closeModal();
  }

  function addIndicator() {
    const id = slugId(
      'indicator',
      local.map((ind) => ind.id),
    );
    setLocal((prev) => [...prev, { id, label: '', x: 0.5, y: 0.5, rx: 0.56, ry: 0.56, rSize: 10 }]);
    setSelectedId(id);
  }

  function removeIndicator(id: string) {
    const next = local.filter((ind) => ind.id !== id);
    setLocal(next);
    if (selectedId === id) setSelectedId(next[0]?.id ?? null);
  }

  function updateLabel(id: string, label: string) {
    setLocal((prev) => prev.map((ind) => (ind.id === id ? { ...ind, label } : ind)));
  }

  function updateSize(id: string, rSize: number) {
    setLocal((prev) => prev.map((ind) => (ind.id === id ? { ...ind, rSize } : ind)));
  }

  // ── Pointer-based drag on image ───────────────────────────────────────────

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, id: string, part: 'circle' | 'pill') => {
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging({ id, part });
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const nx = clamp01((e.clientX - rect.left) / rect.width);
      const ny = clamp01((e.clientY - rect.top) / rect.height);
      const { id, part } = dragging;
      setLocal((prev) =>
        prev.map((ind) => {
          if (ind.id !== id) return ind;
          return part === 'circle' ? { ...ind, x: nx, y: ny } : { ...ind, rx: nx, ry: ny };
        }),
      );
    },
    [dragging],
  );

  const onPointerUp = useCallback(() => {
    setDragging(null);
  }, []);

  return (
    <>
      <button type="button" className="cfg-btn cfg-btn--sm cfg-btn--neutral" onClick={openModal}>
        Edit indicators…
      </button>

      {open && (
        <ModalShell onClose={closeModal} dialogClassName="cfg-ind-modal">
          {/* Header */}
          <div className="cfg-modal-header">
            <span className="cfg-modal-header__title">Edit Indicators</span>
            <ModalCloseButton onClose={closeModal} />
          </div>

          {/* Body — two columns */}
          <div className="cfg-ind-modal-body">
            {/* Left: image canvas */}
            <div
              ref={containerRef}
              className="cfg-ind-image-area"
              style={imgSize ? { aspectRatio: `${imgSize.w} / ${imgSize.h}` } : {}}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            >
              {imageUrl ? (
                <img
                  src={imageUrl}
                  alt=""
                  draggable={false}
                  onLoad={(e) => {
                    const img = e.currentTarget;
                    setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
                  }}
                />
              ) : (
                <span className="cfg-ind-no-image">Image not set — cannot preview</span>
              )}

              {local.map((ind) => {
                const pillX = ind.rx ?? ind.x;
                const pillY = ind.ry ?? ind.y;
                const circDragging = dragging?.id === ind.id && dragging.part === 'circle';
                const pillDragging = dragging?.id === ind.id && dragging.part === 'pill';
                const isSelected = ind.id === selectedId;
                return (
                  <div key={ind.id}>
                    {/* Black circle */}
                    <div
                      className={
                        'cfg-ind-circle' +
                        (circDragging ? ' cfg-ind-circle--dragging' : '') +
                        (isSelected ? ' cfg-ind-circle--selected' : '')
                      }
                      style={{ left: `${ind.x * 100}%`, top: `${ind.y * 100}%` }}
                      onPointerDown={(e) => {
                        setSelectedId(ind.id);
                        onPointerDown(e, ind.id, 'circle');
                      }}
                      title={`Circle: ${ind.label || '(no label)'}`}
                    >
                      {ind.label || '?'}
                    </div>
                    {/* Red dashed circle */}
                    <div
                      className={
                        'cfg-ind-pill' +
                        (pillDragging ? ' cfg-ind-pill--dragging' : '') +
                        (isSelected ? ' cfg-ind-pill--selected' : '')
                      }
                      style={{
                        left: `${pillX * 100}%`,
                        top: `${pillY * 100}%`,
                        width: `${ind.rSize ?? 10}%`,
                      }}
                      onPointerDown={(e) => {
                        setSelectedId(ind.id);
                        onPointerDown(e, ind.id, 'pill');
                      }}
                      title={`Red circle: ${ind.label || '(no label)'}`}
                    />
                  </div>
                );
              })}
            </div>

            {/* Right: indicator list */}
            <div className="cfg-marker-sidebar">
              <div className="cfg-marker-sidebar__header">
                <span className="cfg-marker-sidebar__title">Indicators</span>
                {local.length > 0 && (
                  <span className="cfg-marker-sidebar__count">{local.length}</span>
                )}
                <AddButton title="Add indicator" onClick={addIndicator} />
              </div>

              {local.length === 0 ? (
                <div className="cfg-marker-empty">
                  No indicators yet. Click "+ Add" to place one.
                </div>
              ) : (
                <div className="cfg-marker-list">
                  <div className="cfg-marker-list__head">
                    <div className="cfg-marker-row__main" />
                    <div className="cfg-marker-row__fields">
                      <span className="cfg-marker-col-label cfg-ind-col-label--label">Label</span>
                      <span className="cfg-marker-col-label cfg-ind-col-label--size">Size %</span>
                      <span className="cfg-ind-col-spacer" aria-hidden="true" />
                    </div>
                  </div>
                  {local.map((ind) => {
                    const isSelected = ind.id === selectedId;
                    return (
                      <div
                        key={ind.id}
                        className={
                          'cfg-marker-row' + (isSelected ? ' cfg-marker-row--selected' : '')
                        }
                        onClick={() => setSelectedId(ind.id)}
                      >
                        <div className="cfg-marker-row__main">
                          <div className="cfg-ind-circle cfg-ind-circle--sm" aria-hidden="true">
                            {ind.label || '?'}
                          </div>
                        </div>
                        <div className="cfg-marker-row__fields">
                          <input
                            type="text"
                            className="cfg-prop-input cfg-ind-label-input"
                            value={ind.label}
                            placeholder="A, 1…"
                            onChange={(e) => updateLabel(ind.id, e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                          />
                          <input
                            type="number"
                            className="cfg-prop-input cfg-ind-size-input"
                            value={ind.rSize ?? 10}
                            min={1}
                            max={50}
                            title="Red circle size (% of image)"
                            onChange={(e) => {
                              const n = parseInt(e.target.value, 10);
                              if (!isNaN(n)) updateSize(ind.id, Math.max(1, Math.min(50, n)));
                            }}
                            onClick={(e) => e.stopPropagation()}
                          />
                          <button
                            type="button"
                            className="cfg-row-action-btn"
                            title="Remove"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeIndicator(ind.id);
                            }}
                          >
                            <ClearIcon />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="cfg-ind-footer">
            <button
              type="button"
              className="cfg-btn cfg-btn--ghost cfg-btn--sm"
              onClick={closeModal}
            >
              Cancel
            </button>
            <button
              type="button"
              className="cfg-btn cfg-btn--primary cfg-btn--sm"
              onClick={handleSave}
            >
              Save
            </button>
          </div>
        </ModalShell>
      )}
    </>
  );
}
