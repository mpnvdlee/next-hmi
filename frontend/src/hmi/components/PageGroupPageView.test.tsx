import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useConfigStore } from '@shared/store/configStore';
import { useVariableStore } from '@hmi/store/variableStore';
import type { PageConfig } from '@shared/types/config';
import PageGroupPageView from './PageGroupPageView';

function makePage(id: string): PageConfig {
  return { id, title: `Page ${id}`, type: 'page', sections: { content: [] } };
}

function makeWidgetPage(id: string, type: string): PageConfig {
  return {
    id,
    title: `Page ${id}`,
    type: 'page',
    sections: { content: [{ id: `${id}-w1`, type, name: type }] },
  };
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

  it('reveals a hydrated page without waiting for its variables', () => {
    // No context_ready, no values: a slow datasource must never hold the page.
    // Whatever the widgets have is what they show, and DataSettleGate decides
    // afterwards whether any of it deserves a mark.
    render(<PageGroupPageView pages={[makePage('p1')]} requestedId="p1" onNavigate={() => {}} />);
    expect(isSpinnerShown()).toBe(false);
  });

  it('spins while the page itself is still hydrating', () => {
    useConfigStore.setState({ loadedPageIds: new Set() });
    render(<PageGroupPageView pages={[makePage('p1')]} requestedId="p1" onNavigate={() => {}} />);
    expect(isSpinnerShown()).toBe(true);
  });

  it("holds the spinner until the page's widget modules have landed", async () => {
    // The widget's module still in flight: revealing here is what made a page
    // paint as an empty shell and grow as its lazy() imports returned one by
    // one. Unlike the variables, this is a local file — never the datasource.
    const pages = [makeWidgetPage('p1', 'Label')];
    // A rendered widget reads the route (useEvalContext → useLocation), which
    // the empty-page cases above never reach.
    const view = (
      <MemoryRouter>
        <PageGroupPageView pages={pages} requestedId="p1" onNavigate={() => {}} />
      </MemoryRouter>
    );
    const { unmount } = render(view);
    expect(isSpinnerShown()).toBe(true);

    await waitFor(() => expect(isSpinnerShown()).toBe(false));

    // Second visit: the module is in memory, so the gate must not spin again.
    unmount();
    render(view);
    expect(isSpinnerShown()).toBe(false);
  });

  it("does not leak a previous page's module readiness into a newly navigated page", async () => {
    // PageContent is not remounted between two top-level pages, so the latch
    // has to carry the page id (same fix category as WindowedContent's
    // per-page windowing latch): p2's own widget type is still in flight.
    const pages = [makeWidgetPage('p1', 'Text'), makeWidgetPage('p2', 'Icon')];
    const { rerender } = render(
      <MemoryRouter>
        <PageGroupPageView pages={pages} requestedId="p1" onNavigate={() => {}} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(isSpinnerShown()).toBe(false));

    rerender(
      <MemoryRouter>
        <PageGroupPageView pages={pages} requestedId="p2" onNavigate={() => {}} />
      </MemoryRouter>,
    );
    expect(isSpinnerShown()).toBe(true);
    await waitFor(() => expect(isSpinnerShown()).toBe(false));
  });
});
