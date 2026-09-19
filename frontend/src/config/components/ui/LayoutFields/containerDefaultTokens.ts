import type { LayoutConfig } from '@shared/types/config';

/** Container layout fields whose default comes from a theme token — `gap` and
 *  `radius` from frontend/widgets/Layout/Container/style.css, the four padding
 *  sides from the same fallback inlined in Container/index.tsx (they can't be
 *  a CSS default there: which element applies each one depends on whether the
 *  instance has a title). When unset, the row's placeholder shows the
 *  effective token so the author knows the value is themed and which one.
 *  Split from LayoutFields/index.tsx so panels can pull the token list into
 *  their own {@link usePanelTokenValues} batch without importing a component. */
export const CONTAINER_DEFAULT_TOKENS: Partial<Record<keyof LayoutConfig, string>> = {
  gap: '--hmi-space-sm',
  // The four sides each get their own row, and all four default to the same token.
  paddingTop: '--hmi-space-sm',
  paddingRight: '--hmi-space-sm',
  paddingBottom: '--hmi-space-sm',
  paddingLeft: '--hmi-space-sm',
  radius: '--hmi-radius',
};
