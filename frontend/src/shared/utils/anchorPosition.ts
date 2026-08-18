import type { CSSProperties } from 'react';
import type { AnchorRect, OverlayPlacement } from '@shared/types/config';

const GAP = 6;
const MARGIN = 8;

export function isAnchoredPlacement(placement: OverlayPlacement | undefined): boolean {
  return (
    placement === 'trigger-above' ||
    placement === 'trigger-below' ||
    placement === 'trigger-left' ||
    placement === 'trigger-right'
  );
}

/**
 * Position a panel relative to its trigger's rect (popover style). Mirrors the
 * NavigationMenu flyout offsets, then clamps the panel into the viewport using
 * its measured size (0×0 before the first layout pass yields the raw offset).
 */
export function computeAnchorStyle(
  rect: AnchorRect,
  placement: OverlayPlacement,
  panelSize: { width: number; height: number },
): CSSProperties {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const { width, height } = panelSize;

  let top: number;
  let left: number;

  switch (placement) {
    case 'trigger-above':
      top = rect.top - GAP - height;
      left = rect.left;
      break;
    case 'trigger-left':
      top = rect.top;
      left = rect.left - GAP - width;
      break;
    case 'trigger-right':
      top = rect.top;
      left = rect.right + GAP;
      break;
    case 'trigger-below':
    default:
      top = rect.bottom + GAP;
      left = rect.left;
      break;
  }

  if (width > 0) left = clamp(left, MARGIN, Math.max(MARGIN, vw - width - MARGIN));
  if (height > 0) top = clamp(top, MARGIN, Math.max(MARGIN, vh - height - MARGIN));

  return { position: 'fixed', top, left };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
