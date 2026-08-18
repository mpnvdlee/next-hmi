import { createContext } from 'react';

/** Frozen at module scope: the live runtime never provides this context, so an
 *  identity that changed per render would re-run every window item's memo. */
const NO_SELECTION: ReadonlySet<string> = Object.freeze(new Set<string>()) as ReadonlySet<string>;

/**
 * The currently-selected widget ids in the editor preview.
 *
 * Provided by `PreviewView` and consumed by `WindowedContent`'s window items:
 * preview windows (unmounts off-screen widgets) exactly like the live runtime,
 * but an item whose subtree contains part of the selection is force-mounted so the
 * editor can still highlight (and scroll to) a widget picked from the tree.
 * Always empty in the live runtime — there is no selection there.
 */
export const PreviewSelectionContext = createContext<ReadonlySet<string>>(NO_SELECTION);
