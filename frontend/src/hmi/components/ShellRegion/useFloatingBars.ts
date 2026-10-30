import type { ShellRegionConfig } from '@shared/types/config';
import { evaluatePropertyValue } from '@hmi/utils/propertySourceEval';
import { useReactiveEval } from '@hmi/hooks/useReactiveEval';

/**
 * Resolve the header's and footer's bindable `floating`.
 *
 * Read above `ShellRegion`, like `fullHeight`: a floating bar is placed inside
 * `.hmi-main`, so it lies over the page only and never over a docked sidebar.
 * A floating sidebar needs no such move — it floats in the slot it already has.
 */
export function useFloatingBars(
  headerConfig: ShellRegionConfig,
  footerConfig: ShellRegionConfig,
): { header: boolean; footer: boolean } {
  const evalCtx = useReactiveEval(headerConfig.floating, footerConfig.floating);
  return {
    header: Boolean(evaluatePropertyValue(headerConfig.floating, evalCtx)),
    footer: Boolean(evaluatePropertyValue(footerConfig.floating, evalCtx)),
  };
}
