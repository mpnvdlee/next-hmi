import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useDismissOnOutsideClick from './useDismissOnOutsideClick';

const TAB_DROPDOWN_SPACE = 28;

export function combinedTabs(openTabIds: string[], previewTabId: string | null): string[] {
  return previewTabId && !openTabIds.includes(previewTabId)
    ? [...openTabIds, previewTabId]
    : openTabIds;
}

interface TabCloseState {
  openTabIds: string[];
  previewTabId: string | null;
  activeId: string | null;
}

interface TabCloseResult {
  openTabIds: string[];
  previewTabId: string | null;
  /** Only present when the active tab itself was removed and had to move; omitted (not `null`)
   *  when the active tab is unaffected, so callers with a secondary field derived from the
   *  active id (e.g. a deeper tree selection) know not to touch it. */
  nextActiveId?: string | null;
}

/**
 * Shared close-tabs reducer: drops `removingIds` from the open/preview tabs and, if the
 * active tab was among them, picks the next-nearest surviving tab to activate. Returns
 * `null` when nothing actually changed (no-op).
 */
export function computeCloseTabs(
  state: TabCloseState,
  removingIds: string[],
): TabCloseResult | null {
  const removing = new Set(removingIds);
  const combined = combinedTabs(state.openTabIds, state.previewTabId);
  const openTabIds = state.openTabIds.filter((id) => !removing.has(id));
  const previewTabId =
    state.previewTabId && removing.has(state.previewTabId) ? null : state.previewTabId;
  if (openTabIds.length === state.openTabIds.length && previewTabId === state.previewTabId) {
    return null;
  }
  if (!state.activeId || !removing.has(state.activeId)) {
    return { openTabIds, previewTabId };
  }

  const idx = combined.indexOf(state.activeId);
  const remaining = combinedTabs(openTabIds, previewTabId);
  const nextActiveId = remaining.length > 0 ? remaining[Math.min(idx, remaining.length - 1)] : null;
  return { openTabIds, previewTabId, nextActiveId };
}

export function scrollTabsWithWheel(event: React.WheelEvent<HTMLDivElement>) {
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  const scroller = event.currentTarget;
  if (scroller.scrollWidth <= scroller.clientWidth) return;
  scroller.scrollLeft += event.deltaY;
  event.preventDefault();
}

function tabsOverflow(scroller: HTMLDivElement, dropdownVisible: boolean): boolean {
  const availableWidth = scroller.clientWidth + (dropdownVisible ? TAB_DROPDOWN_SPACE : 0);
  return scroller.scrollWidth > availableWidth;
}

interface TabStripSnapshot {
  openTabIds: string[];
  previewTabId: string | null;
  activeTabId: string | null;
}

/**
 * Shared scroll/overflow/keyboard-nav/dismiss behaviour for a horizontal tab
 * strip. `getSnapshot` must be a stable (e.g. empty-deps useCallback) reader
 * of the owning store so the alt+arrow listener can stay registered once
 * instead of re-binding on every tab change.
 */
export function useTabStrip({
  openTabIds,
  previewTabId,
  getSnapshot,
  setActiveTab,
}: {
  openTabIds: string[];
  previewTabId: string | null;
  getSnapshot: () => TabStripSnapshot;
  setActiveTab: (id: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const tabIds = useMemo(() => combinedTabs(openTabIds, previewTabId), [openTabIds, previewTabId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setOverflows((dropdownVisible) => tabsOverflow(el, dropdownVisible));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const frame = window.requestAnimationFrame(() => {
      setOverflows((dropdownVisible) => tabsOverflow(el, dropdownVisible));
      if (previewTabId && !openTabIds.includes(previewTabId)) {
        el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [openTabIds, previewTabId]);

  useEffect(() => {
    if (!overflows) setDropdownOpen(false);
  }, [overflows]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      e.preventDefault();
      const snap = getSnapshot();
      const tabs = combinedTabs(snap.openTabIds, snap.previewTabId);
      if (tabs.length < 2) return;
      const idx = snap.activeTabId ? tabs.indexOf(snap.activeTabId) : 0;
      const next =
        e.key === 'ArrowLeft' ? (idx - 1 + tabs.length) % tabs.length : (idx + 1) % tabs.length;
      setActiveTab(tabs[next]);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [getSnapshot, setActiveTab]);

  useDismissOnOutsideClick(dropdownRef, () => setDropdownOpen(false), dropdownOpen);

  const handleDropdownSelect = useCallback(
    (tabId: string) => {
      setActiveTab(tabId);
      setDropdownOpen(false);
    },
    [setActiveTab],
  );

  return {
    tabIds,
    scrollRef,
    dropdownRef,
    overflows,
    dropdownOpen,
    setDropdownOpen,
    handleDropdownSelect,
  };
}
