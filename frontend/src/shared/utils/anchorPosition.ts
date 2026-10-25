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
 * NavigationMenu flyout offsets, flips to the opposite side of the trigger when
 * the panel does not fit on its own side but does on the other, then clamps it
 * into the viewport using its measured size (0×0 before the first layout pass
 * yields the raw offset).
 */
export function computeAnchorStyle(
  rect: AnchorRect,
  placement: OverlayPlacement,
  panelSize: { width: number; height: number },
): CSSProperties {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const { width, height } = panelSize;

  const below = rect.bottom + GAP;
  const above = rect.top - GAP - height;
  const right = rect.right + GAP;
  const leftOf = rect.left - GAP - width;
  const fitsY = (y: number) => y >= MARGIN && y + height <= vh - MARGIN;
  const fitsX = (x: number) => x >= MARGIN && x + width <= vw - MARGIN;
  // The asked side, unless only the other one fits.
  const side = (asked: number, other: number, fits: (v: number) => boolean) =>
    !fits(asked) && fits(other) ? other : asked;

  let top: number;
  let left: number;

  switch (placement) {
    case 'trigger-above':
      top = side(above, below, fitsY);
      left = rect.left;
      break;
    case 'trigger-left':
      top = rect.top;
      left = side(leftOf, right, fitsX);
      break;
    case 'trigger-right':
      top = rect.top;
      left = side(right, leftOf, fitsX);
      break;
    case 'trigger-below':
    default:
      top = side(below, above, fitsY);
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
