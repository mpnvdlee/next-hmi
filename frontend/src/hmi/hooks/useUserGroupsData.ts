import { useUsersDocument, type UserGroupEntry } from './useUsersDocument';

/**
 * Reads every configured user group from the session-cached /api/users document.
 * Returns an empty array until the data is available.
 */
export function useUserGroupsData(): UserGroupEntry[] {
  return useUsersDocument().groups;
}
