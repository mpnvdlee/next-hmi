export interface AnchoredPosition {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

/**
 * Shared fixed-position anchoring math for the translation search dropdown
 * and the values popover: clamp horizontally to the viewport, and flip above
 * the anchor when there isn't `neededHeightBelow` px of room below it.
 */
export function computeAnchoredPosition(
  anchorRect: DOMRect,
  idealLeft: number,
  width: number,
  neededHeightBelow: number,
  ownerWindow: Window = window,
): AnchoredPosition {
  const margin = 8;
  const availableWidth = Math.max(0, ownerWindow.innerWidth - margin * 2);
  const clampedWidth = Math.min(width, availableWidth);
  const left = Math.max(
    margin,
    Math.min(idealLeft, ownerWindow.innerWidth - margin - clampedWidth),
  );
  const spaceBelow = ownerWindow.innerHeight - anchorRect.bottom - margin;
  const spaceAbove = anchorRect.top - margin;
  const placeBelow = spaceBelow >= neededHeightBelow || spaceBelow >= spaceAbove;

  return {
    left,
    width: clampedWidth,
    top: placeBelow ? anchorRect.bottom + 4 : undefined,
    bottom: placeBelow ? undefined : ownerWindow.innerHeight - anchorRect.top + 4,
    maxHeight: Math.max(0, placeBelow ? spaceBelow : spaceAbove),
  };
}
