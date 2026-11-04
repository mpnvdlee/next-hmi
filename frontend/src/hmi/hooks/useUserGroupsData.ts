import { useUsersDocument, type UserGroupEntry } from './useUsersDocument';

/**
 * Reads every configured user group from the session-cached /api/users/roster.
 * Returns an empty array until the data is available.
 */
export function useUserGroupsData(): UserGroupEntry[] {
  return useUsersDocument().groups;
}
