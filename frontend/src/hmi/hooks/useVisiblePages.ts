import { useMemo } from 'react';
import { useConfigStore } from '@shared/store/configStore';
import type { PageNode } from '@shared/types/config';
import { filterByRole, filterHidden, sortPagesByOrder } from '@shared/utils/pageTree';
import { useHmiScope } from '@hmi/context/HmiScopeContext';
import { useHmiStore } from '@hmi/store/hmiStore';

const EMPTY_GROUPS: readonly string[] = [];

export function useVisiblePages(): PageNode[] {
  const pages = useConfigStore((s) => s.pages);
  const scope = useHmiScope();
  const userGroups = useHmiStore((s) => s.currentUsersByScope[scope]?.groups ?? EMPTY_GROUPS);
  return useMemo(
    () => sortPagesByOrder(filterByRole(filterHidden(pages), userGroups as string[])),
    [pages, userGroups],
  );
}
