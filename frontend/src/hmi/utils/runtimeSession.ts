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

const PANEL_KEY = 'nexthmi.panel';

/**
 * This tab's panel name, from `?panel=` on the runtime URL, which lets API v1
 * sign a user in on it. Kept in session storage because in-app navigation
 * drops the query string and a reload must not unname the tab.
 */
function loadPanelName(): string | undefined {
  const fromUrl = new URLSearchParams(window.location.search).get('panel') || undefined;
  try {
    if (fromUrl) sessionStorage.setItem(PANEL_KEY, fromUrl);
    return fromUrl ?? sessionStorage.getItem(PANEL_KEY) ?? undefined;
  } catch {
    return fromUrl;
  }
}

let liveScope: string | undefined;

/**
 * Whether *scope* is the view this tab shows: the last one that asked for its
 * identity. A remounted view leaves its old scope on the socket, and that
 * scope's identity must not replace the live login's token. True when no
 * runtime view asked (the editor preview).
 */
export function isLiveScope(scope: string): boolean {
  return liveScope === undefined || liveScope === scope;
}

/** The `request_identity` message a runtime view sends for *scope*. */
export function identityRequest(scope: string) {
  liveScope = scope;
  return {
    type: 'request_identity',
    scope,
    sessionToken: loadSessionToken(),
    panel: loadPanelName(),
  };
}
