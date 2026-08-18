import { createContext, useContext } from 'react';

/**
 * Context that publishes the `window` that owns the subtree being rendered.
 * A popped-out window renders React from the opener's realm, so its DOM nodes
 * live in another document: viewport maths (`innerWidth`/`innerHeight`) and
 * key/scroll/resize listeners must target that window, not the global one.
 * Left unset, the global `window` applies — the in-page case.
 */
export const OwnerWindowContext = createContext<Window | null>(null);

/** Returns the window owning this subtree — the popout's when inside one. */
export function useOwnerWindow(): Window {
  return useContext(OwnerWindowContext) ?? window;
}
