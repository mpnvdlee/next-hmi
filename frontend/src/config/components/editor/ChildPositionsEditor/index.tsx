import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChildPosition, WidgetConfig } from '@shared/types/config';
import WidgetRenderer from '@hmi/components/WidgetRenderer';
import { resolveImageSrc } from '@shared/utils/imageAsset';
import {
  clamp01,
  ensurePositionsForChildren,
  indexPositions,
  pruneOrphanPositions,
  resolveMarkerLabel,
} from '@hmi/components/ImageContainer/positions';
import ModalShell, { ModalCloseButton } from '@config/components/ui/ModalShell';
import '../markerEditor.css';
import './style.css';

interface Props {
  value: ChildPosition[] | undefined;
  /** Raw value of the `src` property from the same component (may be `{ $static: { path } }` or string). */
  src: unknown;
  /** Children of the parent component being edited. */
  childConfigs?: WidgetConfig[];
  onChange: (v: ChildPosition[]) => void;
}

export default function ChildPositionsEditor({ value, src, childConfigs, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [local, setLocal] = useState<ChildPosition[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const imageUrl = resolveImageSrc(src);
  const children = useMemo(() => childConfigs ?? [], [childConfigs]);
  const placements = useMemo(() => (Array.isArray(value) ? value : []), [value]);

  const summary = `${children.length} child${children.length === 1 ? '' : 'ren'} • ${placements.length} placement${placements.length === 1 ? '' : 's'}`;

  function openModal() {
    const pruned = pruneOrphanPositions(placements, childConfigs);
    const ensured = ensurePositionsForChildren(pruned, childConfigs);
    setLocal(ensured);
    setSelectedId(children[0]?.id ?? null);
    setImgSize(null);
    setOpen(true);
  }

  function closeModal() {
    setDragId(null);
    setOpen(false);
  }

  function handleSave() {
    const cleaned = pruneOrphanPositions(local, childConfigs);
    onChange(cleaned);
    closeModal();
  }

  // ── Pointer drag (canvas) ────────────────────────────────────────────────
  useEffect(() => {
    if (!dragId) return;
    function onMove(e: PointerEvent) {
      if (!canvasRef.current || !dragId) return;
      const rect = canvasRef.current.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const nx = clamp01((e.clientX - rect.left) / rect.width);
      const ny = clamp01((e.clientY - rect.top) / rect.height);
      setLocal((prev) => prev.map((p) => (p.id === dragId ? { ...p, x: nx, y: ny } : p)));
    }
    function onUp() {
      setDragId(null);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragId]);

  function updateLabel(id: string, label: string) {
    setLocal((prev) => prev.map((p) => (p.id === id ? { ...p, label } : p)));
  }

  function updateWidth(id: string, raw: string) {
    if (raw === '') {
      setLocal((prev) =>
        prev.map((p) => {
          if (p.id !== id) return p;
          const { width: _ignore, ...rest } = p;
          return rest;
        }),
      );
      return;
    }
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return;
    const clamped = Math.max(1, Math.min(100, n));
    setLocal((prev) => prev.map((p) => (p.id === id ? { ...p, width: clamped } : p)));
  }

  const positionsById = indexPositions(local);

  return (
    <>
      <button
        type="button"
        className="cfg-btn cfg-btn--sm cfg-btn--neutral"
        onClick={openModal}
        disabled={children.length === 0}
        title={
          children.length === 0
            ? 'Add child components first, then place them on the image.'
            : undefined
        }
      >
        Place children…
      </button>
      <span className="cfg-childpos-summary">{summary}</span>

      {open && (
        <ModalShell onClose={closeModal} dialogClassName="cfg-childpos-modal">
          <div className="cfg-modal-header">
            <span className="cfg-modal-header__title">Place children on image</span>
            <ModalCloseButton onClose={closeModal} />
          </div>

          <div className="cfg-childpos-body">
            <div
              ref={canvasRef}
              className="cfg-childpos-canvas"
              style={imgSize ? { aspectRatio: `${imgSize.w} / ${imgSize.h}` } : undefined}
            >
              {imageUrl ? (
                <img
                  src={imageUrl}
                  alt=""
                  draggable={false}
                  className="cfg-childpos-img"
                  onLoad={(e) => {
                    const img = e.currentTarget;
                    setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
                  }}
                />
              ) : (
                <span className="cfg-childpos-noimage">Image not set — cannot preview</span>
              )}

              {children.map((child, treeIndex) => {
                const pos = positionsById.get(child.id);
                if (!pos) return null;
                const isSelected = child.id === selectedId;
                const isDragging = dragId === child.id;
                const label = resolveMarkerLabel(pos, treeIndex);
                const widthStyle = pos.width != null ? { width: `${pos.width}%` } : undefined;
                return (
                  <div
                    key={child.id}
                    className={
                      'cfg-childpos-slot' +
                      (isSelected ? ' cfg-childpos-slot--selected' : '') +
                      (isDragging ? ' cfg-childpos-slot--dragging' : '')
                    }
                    style={{
                      left: `${pos.x * 100}%`,
                      top: `${pos.y * 100}%`,
                      ...widthStyle,
                    }}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setSelectedId(child.id);
                      setDragId(child.id);
                    }}
                    title={child.name || child.type}
                  >
                    <div className="cfg-childpos-preview">
                      <WidgetRenderer node={child} />
                    </div>
                    <span className="cfg-childpos-marker">{label}</span>
                  </div>
                );
              })}
            </div>

            <div className="cfg-marker-sidebar">
              <div className="cfg-marker-sidebar__header">
                <span className="cfg-marker-sidebar__title">Children</span>
                {children.length > 0 && (
                  <span className="cfg-marker-sidebar__count">{children.length}</span>
                )}
              </div>
              {children.length === 0 ? (
                <div className="cfg-marker-empty">
                  No child components. Add some to the component tree first.
                </div>
              ) : (
                <div className="cfg-marker-list">
                  <div className="cfg-marker-list__head cfg-childpos-list__head">
                    <div className="cfg-marker-row__main" />
                    <div className="cfg-marker-row__fields">
                      <span className="cfg-marker-col-label">Label</span>
                      <span className="cfg-marker-col-label">Width %</span>
                    </div>
                  </div>
                  {children.map((child, treeIndex) => {
                    const pos = positionsById.get(child.id);
                    const label = resolveMarkerLabel(pos, treeIndex);
                    const isSelected = child.id === selectedId;
                    return (
                      <div
                        key={child.id}
                        className={
                          'cfg-marker-row' + (isSelected ? ' cfg-marker-row--selected' : '')
                        }
                        onClick={() => setSelectedId(child.id)}
                      >
                        <div className="cfg-marker-row__main">
                          <span
                            className="cfg-childpos-marker cfg-childpos-marker--sm"
                            aria-hidden="true"
                          >
                            {label}
                          </span>
                          <span className="cfg-childpos-row__type">{child.name || child.type}</span>
                        </div>
                        <div className="cfg-marker-row__fields">
                          <input
                            type="text"
                            className="cfg-prop-input cfg-childpos-label-input"
                            value={pos?.label ?? ''}
                            placeholder={resolveMarkerLabel(undefined, treeIndex)}
                            title="Marker label (defaults to auto-letter)"
                            onChange={(e) => updateLabel(child.id, e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                          />
                          <input
                            type="number"
                            className="cfg-prop-input cfg-childpos-width-input"
                            value={pos?.width ?? ''}
                            min={1}
                            max={100}
                            placeholder="auto"
                            title="Width override (% of image width)"
                            onChange={(e) => updateWidth(child.id, e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="cfg-childpos-footer">
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
