import type { ShellRegionConfig } from '@shared/types/config';
import { evaluatePropertyValue } from '@hmi/utils/propertySourceEval';
import { useReactiveEval } from '@hmi/hooks/useReactiveEval';

/**
 * Resolve both sidebars' bindable `fullHeight`.
 *
 * Unlike the other region props this one is read *above* `ShellRegion`: it
 * decides whether the layout is a row (sidebars flanking the whole column) or
 * a column (sidebars between header and footer), so the layout owns it. One
 * hook for both sides keeps it to a single subscription.
 */
export function useSidebarFullHeight(
  leftConfig: ShellRegionConfig,
  rightConfig: ShellRegionConfig,
): { left: boolean; right: boolean; any: boolean } {
  const evalCtx = useReactiveEval(leftConfig.fullHeight, rightConfig.fullHeight);
  const left = Boolean(evaluatePropertyValue(leftConfig.fullHeight, evalCtx));
  const right = Boolean(evaluatePropertyValue(rightConfig.fullHeight, evalCtx));
  return { left, right, any: left || right };
}
