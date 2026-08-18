import './style.css';
import { useCallback, useEffect, useRef } from 'react';

interface Props {
  /** Current width of the panel being resized */
  width: number;
  /** Called with the new width on every frame while dragging */
  onResize: (width: number) => void;
  /** Called with the final width when the drag ends (or on a keyboard/reset change) */
  onResizeEnd?: (width: number) => void;
  /** Which side of the center panel this handle is on */
  side?: 'left' | 'right';
  /** Minimum allowed width (default 200) */
  min?: number;
  /** Maximum allowed width (default 600) */
  max?: number;
  /** The center column may never be squeezed below this (default 320) */
  minCenter?: number;
  /** Width restored on double-click */
  defaultWidth?: number;
  label?: string;
}

const KEY_STEP = 16;
const KEY_STEP_FINE = 2;

interface Drag {
  pointerId: number;
  startX: number;
  startW: number;
  max: number;
  latestX: number;
  frame: number;
  width: number;
}

export default function ResizeHandle({
  width,
  onResize,
  onResizeEnd,
  side = 'right',
  min = 200,
  max = 600,
  minCenter = 320,
  defaultWidth,
  label,
}: Props) {
  const el = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const detach = useRef<(() => void) | null>(null);

  const endDrag = useCallback(() => {
    const d = drag.current;
    detach.current?.();
    detach.current = null;
    if (!d) return;
    drag.current = null;
    if (d.frame) cancelAnimationFrame(d.frame);
    document.body.classList.remove('cfg-resizing');
    try {
      if (el.current?.hasPointerCapture?.(d.pointerId)) {
        el.current.releasePointerCapture(d.pointerId);
      }
    } catch {
      /* the pointer is already gone */
    }
    onResizeEnd?.(d.width);
  }, [onResizeEnd]);

  // A drag that outlives the handle (the panel closes mid-drag) must not leave
  // listeners attached or the body stuck in its resizing state.
  useEffect(() => () => endDrag(), [endDrag]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || drag.current) return;
      e.preventDefault();

      // Whatever room the center column has left is the real ceiling — the
      // configured `max` only applies while the window is wide enough for it.
      const center =
        side === 'left' ? el.current?.nextElementSibling : el.current?.previousElementSibling;
      const centerWidth = center?.getBoundingClientRect().width;
      const headroom = centerWidth ? Math.max(0, centerWidth - minCenter) : Infinity;

      const d: Drag = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startW: width,
        max: Math.max(min, Math.min(max, width + headroom)),
        latestX: e.clientX,
        frame: 0,
        width,
      };
      drag.current = d;

      // Capture keeps every move and the final pointerup in this document even
      // when the cursor crosses the live-preview iframe, which would otherwise
      // swallow them — that is what left drags stuck to the pointer.
      try {
        el.current?.setPointerCapture?.(e.pointerId);
      } catch {
        /* capture is an optimisation; the window listeners still drive the drag */
      }
      document.body.classList.add('cfg-resizing');

      const apply = () => {
        const cur = drag.current;
        if (!cur) return;
        cur.frame = 0;
        const delta = side === 'right' ? cur.startX - cur.latestX : cur.latestX - cur.startX;
        const next = Math.min(cur.max, Math.max(min, cur.startW + delta));
        if (next === cur.width) return;
        cur.width = next;
        onResize(next);
      };

      const onMove = (ev: PointerEvent) => {
        const cur = drag.current;
        if (!cur || ev.pointerId !== cur.pointerId) return;
        cur.latestX = ev.clientX;
        // One update per frame — a raw pointermove stream asks for far more
        // re-renders of the tree and properties panel than the screen can show.
        if (cur.frame) return;
        cur.frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(apply) : 0;
        if (!cur.frame) apply();
      };
      const onUp = (ev: PointerEvent) => {
        if (drag.current && ev.pointerId !== drag.current.pointerId) return;
        endDrag();
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      detach.current = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };
    },
    [width, side, min, max, minCenter, onResize, endDrag],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const grow = side === 'left' ? 'ArrowRight' : 'ArrowLeft';
      const shrink = side === 'left' ? 'ArrowLeft' : 'ArrowRight';
      const step = e.shiftKey ? KEY_STEP_FINE : KEY_STEP;
      let next: number | null = null;

      if (e.key === grow) next = width + step;
      else if (e.key === shrink) next = width - step;
      else if (e.key === 'Home') next = min;
      else if (e.key === 'End') next = max;
      if (next === null) return;

      e.preventDefault();
      next = Math.min(max, Math.max(min, next));
      onResize(next);
      onResizeEnd?.(next);
    },
    [width, side, min, max, onResize, onResizeEnd],
  );

  const onDoubleClick = useCallback(() => {
    if (defaultWidth === undefined) return;
    onResize(defaultWidth);
    onResizeEnd?.(defaultWidth);
  }, [defaultWidth, onResize, onResizeEnd]);

  return (
    <div
      ref={el}
      className="cfg-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={label ?? 'Resize panel'}
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={onDoubleClick}
    />
  );
}
