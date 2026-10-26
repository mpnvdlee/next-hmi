/**
 * The runtime login token, kept per browser tab so a reconnect or reload can
 * resume the login (`request_identity` with `sessionToken`) instead of falling
 * back to the auto-login user. Session storage, so closing the tab logs out.
 */
const KEY = 'nexthmi.runtimeSession';

export function loadSessionToken(): string | undefined {
  try {
    return sessionStorage.getItem(KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Store the token a `user_identity` carried, or forget it when it carried none. */
export function saveSessionToken(token: string | undefined): void {
  try {
    if (token) sessionStorage.setItem(KEY, token);
    else sessionStorage.removeItem(KEY);
  } catch {
    // Blocked storage: the login just won't survive a reload.
  }
}
