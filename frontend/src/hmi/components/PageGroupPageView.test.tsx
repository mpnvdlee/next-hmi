import { act, render, screen } from '@testing-library/react';
import { useConfigStore } from '@shared/store/configStore';
import { useVariableStore } from '@hmi/store/variableStore';
import type { PageConfig } from '@shared/types/config';
import PageGroupPageView from './PageGroupPageView';

function makePage(id: string): PageConfig {
  return { id, title: `Page ${id}`, type: 'page', sections: { content: [] } };
}

function isSpinnerShown(): boolean {
  return screen.queryByRole('status') !== null;
}

describe('PageGroupPageView / PageContent readiness gate', () => {
  beforeEach(() => {
    useConfigStore.setState({ loadedPageIds: new Set(['p1', 'p2']) });
    useVariableStore.setState({
      values: {},
      varMeta: {},
      snapshotReceived: true,
      contextReadyPageIds: [],
      wsConnected: true,
      opcuaConnected: {},
    });
  });

  it('shows a spinner while hydrated but not yet context-ready', () => {
    render(<PageGroupPageView pages={[makePage('p1')]} requestedId="p1" onNavigate={() => {}} />);
    expect(isSpinnerShown()).toBe(true);
  });

  it('reveals content once the page id appears in contextReadyPageIds', () => {
    useVariableStore.setState({ contextReadyPageIds: ['p1'] });
    render(<PageGroupPageView pages={[makePage('p1')]} requestedId="p1" onNavigate={() => {}} />);
    expect(isSpinnerShown()).toBe(false);
  });

  it("does not leak a previous page's readiness into a newly navigated page", () => {
    // p1 is ready; navigating to p2 (not yet in contextReadyPageIds) must spin
    // again, even though PageContent is not remounted between two top-level
    // pages (same fix category as WindowedContent's per-page windowing latch).
    useVariableStore.setState({ contextReadyPageIds: ['p1'] });
    const pages = [makePage('p1'), makePage('p2')];
    const { rerender } = render(
      <PageGroupPageView pages={pages} requestedId="p1" onNavigate={() => {}} />,
    );
    expect(isSpinnerShown()).toBe(false);

    rerender(<PageGroupPageView pages={pages} requestedId="p2" onNavigate={() => {}} />);
    expect(isSpinnerShown()).toBe(true);
  });

  it("a page's timed-out safety valve does not leak into the next page", () => {
    vi.useFakeTimers();
    try {
      const pages = [makePage('p1'), makePage('p2')];
      const { rerender } = render(
        <PageGroupPageView pages={pages} requestedId="p1" onNavigate={() => {}} />,
      );
      expect(isSpinnerShown()).toBe(true);

      act(() => {
        vi.advanceTimersByTime(1300);
      });
      expect(isSpinnerShown()).toBe(false); // p1's own safety valve fired

      rerender(<PageGroupPageView pages={pages} requestedId="p2" onNavigate={() => {}} />);
      expect(isSpinnerShown()).toBe(true); // p2 must wait for its own signal/timeout
    } finally {
      vi.useRealTimers();
    }
  });
});
