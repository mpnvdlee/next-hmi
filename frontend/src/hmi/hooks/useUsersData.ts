import { useUsersDocument, type UserEntry } from './useUsersDocument';

/**
 * Reads the user list from the session-cached /api/users document.
 * Returns an empty array until the data is available.
 */
export function useUsersData(): UserEntry[] {
  return useUsersDocument().users;
}
