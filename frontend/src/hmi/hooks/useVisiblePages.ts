import { useMemo } from 'react';
import { useConfigStore } from '@shared/store/configStore';
import type { PageNode } from '@shared/types/config';
import { filterByRole, filterHidden, sortPagesByOrder } from '@shared/utils/pageTree';
import { useHmiScope } from '@hmi/context/HmiScopeContext';
import { useHmiStore } from '@hmi/store/hmiStore';

const EMPTY_GROUPS: readonly string[] = [];

/**
 * Raw group ids of the signed-in user — `[]` when nobody is signed in.
 *
 * Deliberately *not* `resolveUserGroups()` from the eval context, which answers
 * `['guest']` for an anonymous viewer so that a `$userGroups` gate naming
 * `guest` matches one. Page `role` gating predates that and counts an anonymous
 * viewer as a member of nothing, so a page gated on `guest` stays hidden until
 * someone signs in.
 *
 * Exported (and on the SDK) because a menu that renders *nested* levels has to
 * reapply the same role filter itself — the shared `pageTree` helpers are
 * shallow by design. Sharing the group source is what stops the two levels of
 * one menu from disagreeing about who a viewer is.
 */
export function useCurrentUserGroups(): readonly string[] {
  const scope = useHmiScope();
  return useHmiStore((s) => s.currentUsersByScope[scope]?.groups ?? EMPTY_GROUPS);
}

export function useVisiblePages(): PageNode[] {
  const pages = useConfigStore((s) => s.pages);
  const userGroups = useCurrentUserGroups();
  return useMemo(
    () => sortPagesByOrder(filterByRole(filterHidden(pages), userGroups as string[])),
    [pages, userGroups],
  );
}
