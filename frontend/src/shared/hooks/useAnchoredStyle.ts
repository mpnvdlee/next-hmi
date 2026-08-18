import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import type { AnchorRect, OverlayPlacement } from '@shared/types/config';
import { computeAnchorStyle } from '@shared/utils/anchorPosition';

/**
 * Positions a panel against a trigger's anchor rect (popover style): renders at
 * the raw offset first, then measures itself and repositions clamped into the
 * viewport once its real size is known. Pass `null` for `rect`/`placement` when
 * the panel isn't anchored — the returned style is then just `{}`.
 */
export function useAnchoredStyle(
  rect: AnchorRect | null | undefined,
  placement: OverlayPlacement | null | undefined,
): [RefObject<HTMLDivElement | null>, CSSProperties] {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>(() =>
    rect && placement ? computeAnchorStyle(rect, placement, { width: 0, height: 0 }) : {},
  );
  useLayoutEffect(() => {
    const el = ref.current;
    if (!rect || !placement || !el) return;
    setStyle(
      computeAnchorStyle(rect, placement, { width: el.offsetWidth, height: el.offsetHeight }),
    );
  }, [rect, placement]);
  return [ref, style];
}
