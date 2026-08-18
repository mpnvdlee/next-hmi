import type { ViewportSize } from '@shared/types/config';

/** Pixel breakpoints — `phone` ≤ phoneMax, `tablet` ≤ tabletMax, otherwise `laptop`. */
export interface ViewportBreakpoints {
  phoneMax: number;
  tabletMax: number;
}

export const DEFAULT_VIEWPORT_BREAKPOINTS: ViewportBreakpoints = {
  phoneMax: 600,
  tabletMax: 1024,
};

export function classifyViewport(
  width: number,
  bp: ViewportBreakpoints = DEFAULT_VIEWPORT_BREAKPOINTS,
): ViewportSize {
  if (width <= bp.phoneMax) return 'phone';
  if (width <= bp.tabletMax) return 'tablet';
  return 'laptop';
}
