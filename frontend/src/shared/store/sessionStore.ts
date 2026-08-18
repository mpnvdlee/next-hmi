import { create } from 'zustand';

/**
 * Whether this document has lost the manager's device-admin session.
 *
 * Set from the single `setSessionExpiredHandler` seam in `shared/utils/api`, so
 * every gated call that 401s lands here instead of leaving each store to fail
 * silently into the console.
 */
interface SessionStore {
  managerSessionExpired: boolean;
  markManagerSessionExpired(): void;
}

export const useSessionStore = create<SessionStore>((set) => ({
  managerSessionExpired: false,
  markManagerSessionExpired: () => set({ managerSessionExpired: true }),
}));

/**
 * Origin-root sign-in URL that returns to this document afterwards.
 *
 * Always absolute from the origin — the manager's login screen is served at
 * `/`, never under the `/runtime/<slug>/` or `/editor/<slug>/` base this
 * document carries.
 */
export function managerSignInUrl(): string {
  const target = `${window.location.pathname}${window.location.search}`;
  return `/?signIn=${encodeURIComponent(target)}`;
}

/**
 * The `signIn` destination to resume after signing in, or `null`.
 *
 * Mirrors `safe_sign_in_target` in `backend/manager.py`: only same-origin
 * project-instance paths are honoured, so a crafted link cannot turn the
 * sign-in round-trip into an open redirect.
 */
export function safeSignInTarget(raw: string | null): string | null {
  if (!raw || !raw.startsWith('/')) return null;
  if (/[\\\r\n]/.test(raw)) return null;
  return /^\/(runtime|editor)\//.test(raw) ? raw : null;
}
