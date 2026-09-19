import { act, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from 'react-router-dom';
import { useConfigStore } from '@shared/store/configStore';
import { useHmiStore } from '@hmi/store/hmiStore';
import type { ButtonAction, PageGroupChild, PageNode } from '@shared/types/config';
import { diffPageTrail, usePageEvents } from './usePageEvents';

const executeWidgetActions = vi.hoisted(() => vi.fn());
vi.mock('@hmi/utils/widgetActions', () => ({ executeWidgetActions }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A recognisable action list — the tests assert on `pageId` to say which
 *  node's handler ran, so each one is tagged `<nodeId>:<event>`. */
function tag(nodeId: string, event: 'open' | 'close'): ButtonAction[] {
  return [{ type: 'closePageOverlay', pageId: `${nodeId}:${event}` } as ButtonAction];
}

function page(id: string, events?: { open?: boolean; close?: boolean }): PageNode {
  return {
    id,
    title: id,
    type: 'page',
    sections: { content: [] },
    events: {
      ...(events?.open !== false ? { onOpen: tag(id, 'open') } : {}),
      ...(events?.close !== false ? { onClose: tag(id, 'close') } : {}),
    },
  };
}

function group(id: string, children: PageGroupChild[]): PageNode {
  return {
    id,
    title: id,
    type: 'page-group',
    children,
    events: { onOpen: tag(id, 'open'), onClose: tag(id, 'close') },
  };
}

/** The `<nodeId>:<event>` tags fired so far, in order. */
function fired(): string[] {
  return executeWidgetActions.mock.calls
    .filter(([actions]) => Array.isArray(actions) && actions.length > 0)
    .map(([actions]) => (actions[0] as { pageId: string }).pageId);
}

// Captured from inside the router so a test can navigate without remounting
// it — a fresh MemoryRouter would remount Probe and reset the hook's refs,
// which is exactly the state a navigation must not produce.
let navigate: NavigateFunction;

function Probe() {
  navigate = useNavigate();
  usePageEvents('runtime:test');
  return null;
}

function renderAt(pageId: string) {
  return render(
    <MemoryRouter initialEntries={[`/hmi/${pageId}`]}>
      <Routes>
        <Route path="/hmi/:id" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

function goTo(pageId: string) {
  act(() => navigate(`/hmi/${pageId}`));
}

function setOverlays(pageIds: string[]) {
  act(() =>
    useHmiStore.setState({
      openPageOverlays: pageIds.map((pageId) => ({
        pageId,
        componentProperties: {},
        size: 'auto' as const,
        placement: 'center' as const,
      })),
    }),
  );
}

beforeEach(() => {
  executeWidgetActions.mockClear();
  useHmiStore.setState({ openPageOverlays: [] });
  useConfigStore.setState({
    pages: [
      group('groupA', [page('a1'), page('a2'), group('nested', [page('n1')])]),
      group('groupB', [page('b1')]),
      page('solo'),
    ],
    loadedPageIds: new Set<string>(),
  });
});

// ---------------------------------------------------------------------------
// diffPageTrail
// ---------------------------------------------------------------------------
describe('diffPageTrail', () => {
  const a = page('a');
  const b = page('b');
  const g = group('g', []);
  const h = group('h', []);

  it('reports nothing for an unchanged trail', () => {
    expect(diffPageTrail([g, a], [g, a])).toEqual({ closed: [], opened: [] });
  });

  it('keeps a shared group open across sibling navigation', () => {
    expect(diffPageTrail([g, a], [g, b])).toEqual({ closed: [a], opened: [b] });
  });

  it('closes deepest-first and opens outermost-first', () => {
    expect(diffPageTrail([g, h, a], [b])).toEqual({ closed: [a, h, g], opened: [b] });
  });

  it('opens the whole trail when there was none', () => {
    expect(diffPageTrail([], [g, a])).toEqual({ closed: [], opened: [g, a] });
  });
});

// ---------------------------------------------------------------------------
// usePageEvents — routed navigation
// ---------------------------------------------------------------------------
describe('usePageEvents — routed navigation', () => {
  it('opens the group trail then the page on first render', () => {
    renderAt('a1');
    expect(fired()).toEqual(['groupA:open', 'a1:open']);
  });

  it('fires nothing while no page resolves', () => {
    useConfigStore.setState({ pages: [] });
    renderAt('a1');
    expect(fired()).toEqual([]);
  });

  it('leaves the group alone when moving between its own pages', () => {
    renderAt('a1');
    executeWidgetActions.mockClear();
    goTo('a2');
    expect(fired()).toEqual(['a1:close', 'a2:open']);
  });

  it('closes the old trail deepest-first before opening the new one', () => {
    renderAt('n1');
    executeWidgetActions.mockClear();
    goTo('b1');
    expect(fired()).toEqual(['n1:close', 'nested:close', 'groupA:close', 'groupB:open', 'b1:open']);
  });

  it('unwinds and rewinds nested groups when crossing between them', () => {
    renderAt('n1');
    expect(fired()).toEqual(['groupA:open', 'nested:open', 'n1:open']);
  });

  it('skips a node with no handler for the event', () => {
    useConfigStore.setState({ pages: [page('quiet', { open: false })] });
    renderAt('quiet');
    expect(fired()).toEqual([]);
  });

  it('fires the group when a route names it and falls back to its first child', () => {
    renderAt('groupB');
    expect(fired()).toEqual(['groupB:open', 'b1:open']);
  });
});

// ---------------------------------------------------------------------------
// usePageEvents — overlays
// ---------------------------------------------------------------------------
describe('usePageEvents — page overlays', () => {
  it('resolves the overlay through its own group trail, exactly like routing there would', () => {
    // `a1` sits inside `groupA` in the main tree — the same trail a route to
    // `a1` would open, tracked independently of the routed page ('solo').
    renderAt('solo');
    executeWidgetActions.mockClear();
    setOverlays(['a1']);
    expect(fired()).toEqual(['groupA:open', 'a1:open']);
  });

  it("fires a page group's own open/close when it is the overlay's target, not just its first child", () => {
    renderAt('solo');
    executeWidgetActions.mockClear();
    setOverlays(['groupB']);
    expect(fired()).toEqual(['groupB:open', 'b1:open']);

    executeWidgetActions.mockClear();
    setOverlays([]);
    expect(fired()).toEqual(['b1:close', 'groupB:close']);
  });

  it('closes the overlay page when it is dismissed', () => {
    renderAt('solo');
    setOverlays(['a1']);
    executeWidgetActions.mockClear();
    setOverlays([]);
    expect(fired()).toEqual(['a1:close', 'groupA:close']);
  });

  it('closes the old page and opens the new one when an overlay navigates', () => {
    renderAt('solo');
    setOverlays(['a1']);
    executeWidgetActions.mockClear();
    setOverlays(['a2']);
    // groupA is shared by both trails, so it stays open across the swap —
    // the overlay tracker diffs one concatenated trail, not a set of pages.
    expect(fired()).toEqual(['a1:close', 'a2:open']);
  });

  it('leaves the group alone when an overlay navigates between its own pages', () => {
    renderAt('solo');
    setOverlays(['groupA']);
    executeWidgetActions.mockClear();
    act(() => useHmiStore.getState().updatePageOverlay('groupA', 'a2'));
    expect(fired()).toEqual(['a1:close', 'a2:open']);
  });
});
