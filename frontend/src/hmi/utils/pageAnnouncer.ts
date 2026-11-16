/**
 * Lets a navigation ask for the page it opens before React builds that page.
 *
 * React Router runs each navigation as a React transition, and HmiView's
 * context effect fires only once the new page has been built and drawn — so a
 * page drew first and the values the server already held for it arrived a
 * frame or two later, long enough for a widget whose Visible reads a hidden
 * tag to show. HmiView registers the context it would send; a navigation sends
 * it at once, and HmiView's own effect then finds it already sent.
 */
let announcer: ((pageId: string) => void) | null = null;

export function setPageAnnouncer(fn: ((pageId: string) => void) | null): void {
  announcer = fn;
}

/** Send the context for `pageId` now, when the runtime is mounted to send one. */
export function announcePage(pageId: string): void {
  announcer?.(pageId);
}
