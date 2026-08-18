import type { LayoutConfig } from '@shared/types/config';

/** Container layout fields whose default comes from a theme token (see
 *  frontend/widgets/Layout/Container/style.css). When unset, the row's placeholder shows the
 *  effective token so the author knows the value is themed and which one.
 *  Split from LayoutFields/index.tsx so panels can pull the token list into
 *  their own {@link usePanelTokenValues} batch without importing a component. */
export const CONTAINER_DEFAULT_TOKENS: Partial<Record<keyof LayoutConfig, string>> = {
  gap: '--hmi-space-sm',
  padding: '--hmi-space-sm',
  paddingTop: '--hmi-space-sm',
  paddingRight: '--hmi-space-sm',
  paddingBottom: '--hmi-space-sm',
  paddingLeft: '--hmi-space-sm',
  margin: '--hmi-space-sm',
  marginTop: '--hmi-space-sm',
  marginRight: '--hmi-space-sm',
  marginBottom: '--hmi-space-sm',
  marginLeft: '--hmi-space-sm',
  radius: '--hmi-radius',
};
