/** `MIN_PASSWORD_LENGTH` in backend/core/manager_auth.py, which has the last word. */
export const MIN_ADMIN_PASSWORD_LENGTH = 8;

/** Counted in code points, as the backend's `len()` counts them. */
export function passwordLength(password: string): number {
  return [...password].length;
}

export function meetsAdminPasswordRule(password: string): boolean {
  return passwordLength(password) >= MIN_ADMIN_PASSWORD_LENGTH;
}
