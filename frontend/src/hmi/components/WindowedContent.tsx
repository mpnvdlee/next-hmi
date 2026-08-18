import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { WidgetConfig } from '@shared/types/config';
import type { CSSWithVars } from '@shared/types/style';
import { useComponentStore, selectComponentById } from '@shared/store/componentStore';
import { PreviewSelectionContext } from '../context/PreviewSelectionContext';
import { useHostPageId } from '../context/HostPageContext';

/**
 * Off-screen windowing for a page's top-level content widgets.
 *
 * On a heavy page (e.g. 163 stacked component instances) mounting every widget
 * up front dominates load, and keeping them all mounted dominates scroll. This
 * gates each top-level child on viewport proximity: only widgets within
 * `OVERSCAN_VIEWPORTS` screenfuls of the viewport are mounted; the rest unmount
 * into lightweight placeholders sized from a running height average, so the
 * mounted set stays bounded and scrolling a heavy page stays cheap.
 *
 * Unmounting would normally reset a widget's local state, so a widget the
 * operator has interacted with — focus has landed somewhere inside it (a
 * half-typed input, an open dropdown, a chart with a chosen range) — is pinned
 * mounted for the rest of the page's life, and scrolling back finds it intact.
 * Pure display widgets (the common case) hold no such state and re-derive from
 * the variable store on remount, so they window freely. `content-visibility`
 * (lever 1, in hmi.css) skips paint for the mounted-but-off-screen remainder.
 *
 * Above `WINDOW_THRESHOLD` items the editor preview behaves like the live
 * runtime, with one concession: the window item whose subtree contains the
 * current selection is force-mounted (via `PreviewSelectionContext`) so a widget
 * picked from the editor tree can still be highlighted/scrolled to while
 * off-screen. Below the threshold it renders children exactly as before — no
 * wrappers — and once a page has crossed the threshold it stays windowed (a
 * later dip back under it would otherwise remount every child and drop state).
 */

const WINDOW_THRESHOLD = 40;
// Overscan expressed in viewports: widgets within this many screenfuls above and
// below the viewport mount ahead of time, so scrolling lands on already-mounted
// content. Viewport-relative (rootMargin %) so it adapts to screen size.
const OVERSCAN_VIEWPORTS = 1;
const DEFAULT_ITEM_HEIGHT = 64;

interface WindowApi {
  /** Report a measured item height into the running average (seeds placeholders). */
  report: (height: number) => void;
  /** Latest running-average height; read at render for a not-yet-measured item. */
  estimateRef: { current: number };
}

const WindowApiContext = createContext<WindowApi>({
  report: () => {},
  estimateRef: { current: DEFAULT_ITEM_HEIGHT },
});

interface WindowedContentProps {
  items: WidgetConfig[];
  render: (item: WidgetConfig) => ReactNode;
}

export default function WindowedContent({ items, render }: WindowedContentProps) {
  // Latch on: once a page crosses the threshold it stays windowed, so a live
  // edit nudging the count back under it can't flip the branch and remount
  // (and drop the state of) every child. Keyed by host page id rather than
  // just living on this component instance: PageContent (and this component
  // inside it) is not remounted when navigating between two already-hydrated
  // sibling pages, so an instance-wide latch would stay "on" for every
  // lighter page visited after a single heavy one. Falls back to a fixed key
  // outside a page context (e.g. tests), matching the old per-instance latch.
  const hostPageId = useHostPageId();
  const latchKey = hostPageId ?? '__default__';
  const latchedKeys = useRef<Set<string>>(new Set());
  if (items.length > WINDOW_THRESHOLD) latchedKeys.current.add(latchKey);
  const enabled = latchedKeys.current.has(latchKey);

  // Running average of measured heights lives in a stable object (not React
  // state that re-renders), so reporting a height never re-renders the item list
  // — WindowItems read the estimate at their own render, and a slightly-off seed
  // only nudges the scrollbar once when a placeholder first mounts.
  const [api] = useState<WindowApi>(() => {
    const estimateRef = { current: DEFAULT_ITEM_HEIGHT };
    const measured = { sum: 0, count: 0 };
    return {
      estimateRef,
      report: (height: number) => {
        if (height <= 0) return;
        measured.sum += height;
        measured.count += 1;
        estimateRef.current = measured.sum / measured.count;
      },
    };
  });

  if (!enabled) return <>{items.map(render)}</>;

  return (
    <WindowApiContext.Provider value={api}>
      {items.map((item) => (
        <WindowItem key={item.id} item={item}>
          {render(item)}
        </WindowItem>
      ))}
    </WindowApiContext.Provider>
  );
}

function WindowItem({ item, children }: { item: WidgetConfig; children: ReactNode }) {
  const { report, estimateRef } = useContext(WindowApiContext);
  const selectedIds = useContext(PreviewSelectionContext);
  const ref = useRef<HTMLDivElement>(null);
  // Within the overscan window — toggles both ways as the item scrolls in/out.
  const [near, setNear] = useState(false);
  // Latched once the operator focuses anything inside; keeps the item mounted
  // even when it scrolls out, so its local state isn't reset (see below).
  const [pinned, setPinned] = useState(false);
  const heightRef = useRef<number | undefined>(undefined);

  // Keep an item holding part of the editor selection mounted even when off-screen,
  // so a widget picked from the tree can be highlighted/scrolled to (preview only;
  // the selection is always empty in the live runtime, so this is a no-op there).
  // Memoised on the (stable) item + selection so the subtree walk runs once per
  // selection change, not on every render while a selection is active.
  const forced = useMemo(
    () => selectedIds.size > 0 && subtreeContainsWidget([item], selectedIds),
    [item, selectedIds],
  );
  const mounted = near || pinned || forced;

  // Mount within the overscan window and unmount again once far away, so the
  // mounted set stays bounded and scroll stays cheap.
  useEffect(() => {
    const el = ref.current;
    // No IntersectionObserver (jsdom / very old browsers): mount everything.
    if (!el || typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => setNear(entries[entries.length - 1]?.isIntersecting ?? false),
      { rootMargin: `${OVERSCAN_VIEWPORTS * 100}% 0px` },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Pin on first interaction (focus bubbles up from any descendant), so a widget
  // the operator has touched keeps its live state when it scrolls out of view
  // instead of unmounting and resetting. Display widgets never focus, so they
  // window freely.
  useEffect(() => {
    const el = ref.current;
    if (!el || pinned) return;
    const onFocusIn = () => setPinned(true);
    el.addEventListener('focusin', onFocusIn);
    return () => el.removeEventListener('focusin', onFocusIn);
  }, [pinned]);

  // Remember the real height while mounted so the placeholder for a not-yet-shown
  // item below keeps the scroll estimate accurate.
  useEffect(() => {
    const el = ref.current;
    if (!mounted || !el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const h = el.offsetHeight;
      if (h > 0) {
        heightRef.current = h;
        report(h);
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [mounted, report]);

  const placeholderStyle: CSSWithVars = {
    '--hmi-window-item-h': `${heightRef.current ?? estimateRef.current}px`,
  };

  return (
    <div
      ref={ref}
      className="hmi-window-item"
      data-windowed={mounted ? 'on' : 'off'}
      style={mounted ? undefined : placeholderStyle}
    >
      {mounted ? children : null}
    </div>
  );
}

/**
 * Does any node in `roots` — descending through plain children AND into the
 * definitions of `$component:` instances (whose rendered widgets live in the
 * component store, not on the instance node) — carry one of `ids`? Used only in the
 * editor preview to force-mount the window items owning the selection. One walk
 * regardless of how many are selected. Reads the component store lazily (never in
 * the live runtime, where the selection is empty).
 */
function subtreeContainsWidget(
  roots: WidgetConfig[],
  ids: ReadonlySet<string>,
  seenComponents: Set<string> = new Set(),
): boolean {
  for (const node of roots) {
    if (ids.has(node.id)) return true;
    const kids = node.children as WidgetConfig[] | undefined;
    if (kids && subtreeContainsWidget(kids, ids, seenComponents)) return true;
    // A `$component:` node's own children are the slot content authored on the
    // instance; the widgets the definition draws are a separate tree, so both
    // have to be searched.
    if (typeof node.type === 'string' && node.type.startsWith('$component:')) {
      const name = node.type.slice('$component:'.length);
      if (seenComponents.has(name)) continue;
      seenComponents.add(name);
      const definition = componentChildren(name);
      if (definition && subtreeContainsWidget(definition, ids, seenComponents)) return true;
    }
  }
  return false;
}

function componentChildren(name: string): WidgetConfig[] | undefined {
  const store = useComponentStore.getState();
  const def = store.draftComponents[name] ?? selectComponentById(store.components, name);
  return def?.children as WidgetConfig[] | undefined;
}
