import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useConfigStore } from '@shared/store/configStore';
import { useVariableStore } from '@hmi/store/variableStore';
import type { PageConfig, PageGroupConfig } from '@shared/types/config';
import { widgetRegistry } from '@hmi/registry/widgetRegistry';
import { LabeledProbe } from './__fixtures__/probeWidgets';
import { useEvalContext } from '@hmi/hooks/useEvalContext';
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

  it('reveals a page whose content fetch failed instead of spinning forever', () => {
    // `configStore.loadPageContent` swallows a failed fetch without ever adding
    // the id to `loadedPageIds`, and nothing re-triggers it — `hydrated` would
    // otherwise stay false permanently. The module half's own safety valve is
    // the only way back short of navigating away and back.
    vi.useFakeTimers();
    try {
      useConfigStore.setState({ loadedPageIds: new Set() });
      render(<PageGroupPageView pages={[makePage('p1')]} requestedId="p1" onNavigate={() => {}} />);
      expect(isSpinnerShown()).toBe(true);

      act(() => {
        vi.advanceTimersByTime(5100);
      });
      expect(isSpinnerShown()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
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

describe('PageGroupPageView / $page inside a page-group chrome band', () => {
  beforeEach(() => {
    useConfigStore.setState({
      loadedPageIds: new Set(['step1', 'step2']),
      pages: [makeWizard()] as never,
    });
    // A probe widget standing in for any band widget that reads `$page` — a
    // step counter, a title, a `$switch`-gated PageNavigator.
    widgetRegistry.PageIdProbe = {
      name: 'PageIdProbe',
      component: function PageIdProbe() {
        const evalCtx = useEvalContext();
        return <span data-testid="band-page-id">{String(evalCtx.resolvePage?.('id'))}</span>;
      },
      schema: {},
      category: 'test',
    };
  });

  afterEach(() => {
    delete widgetRegistry.PageIdProbe;
  });

  function makeWizard(): PageGroupConfig {
    return {
      id: 'wizard',
      title: 'Wizard',
      type: 'page-group',
      header: [{ id: 'band-probe', type: 'PageIdProbe', name: 'PageIdProbe' }],
      children: [makePage('step1'), makePage('step2')],
    } as unknown as PageGroupConfig;
  }

  function renderAt(requestedId: string) {
    return (
      <MemoryRouter initialEntries={['/pages/elsewhere']}>
        <PageGroupPageView pages={[makeWizard()]} requestedId={requestedId} onNavigate={() => {}} />
      </MemoryRouter>
    );
  }

  it("reports the group's active child, not the route, in a shared header band", async () => {
    // The route names a different page — the shape a page overlay has, since
    // `openPageOverlay` renders a page group without touching the URL. A band
    // that reads the route cannot tell its own steps apart.
    render(renderAt('step2'));
    await waitFor(() => expect(screen.getByTestId('band-page-id')).toHaveTextContent(/^step2$/));
  });

  it('follows the active child as the group navigates between steps', async () => {
    const { rerender } = render(renderAt('step1'));
    await waitFor(() => expect(screen.getByTestId('band-page-id')).toHaveTextContent(/^step1$/));

    rerender(renderAt('step2'));
    await waitFor(() => expect(screen.getByTestId('band-page-id')).toHaveTextContent(/^step2$/));
  });
});

describe('PageGroupPageView / input properties on a routed page', () => {
  // Only a Dialogs-folder node takes input parameters — `ModalStack` derives
  // that as `root === 'dialogs'` for the node an `openDialog` action
  // named, and passes it down as `takesInputs`. These fixtures stand in for
  // exactly that kind of target (declared defaults an overlay would supply),
  // so the tests below pass `takesInputs` the same way, rather than going
  // through ModalStack's own resolution just to reach this component.
  beforeEach(() => {
    useConfigStore.setState({ loadedPageIds: new Set(['detail']) });
    widgetRegistry.LabeledProbe = LabeledProbe;
  });

  afterEach(() => {
    delete widgetRegistry.LabeledProbe;
  });

  function paramPage(): PageConfig {
    return {
      id: 'detail',
      title: 'Detail',
      type: 'page',
      componentProperties: { motorId: { type: 'String', label: 'Motor', defaultValue: 'M1' } },
      sections: {
        content: [
          {
            id: 'probe',
            type: 'LabeledProbe',
            name: 'Probe',
            properties: { label: { $componentProp: 'motorId' } },
          },
        ],
      },
    } as unknown as PageConfig;
  }

  function groupedPage(): PageGroupConfig {
    return {
      id: 'outer',
      title: 'Outer',
      type: 'page-group',
      componentProperties: { motorId: { type: 'String', label: 'Motor', defaultValue: 'OUTER' } },
      children: [
        {
          id: 'inner',
          title: 'Inner',
          type: 'page-group',
          componentProperties: {
            motorId: { type: 'String', label: 'Motor', defaultValue: 'INNER' },
          },
          children: [
            {
              id: 'detail',
              title: 'Detail',
              type: 'page',
              sections: {
                content: [
                  {
                    id: 'probe',
                    type: 'LabeledProbe',
                    name: 'Probe',
                    properties: { label: { $componentProp: 'motorId' } },
                  },
                ],
              },
            },
          ],
        },
      ],
    } as unknown as PageGroupConfig;
  }

  it('takes the innermost group default for a page that declares nothing', async () => {
    render(
      <MemoryRouter>
        <PageGroupPageView
          pages={[groupedPage()]}
          requestedId="detail"
          onNavigate={() => {}}
          takesInputs
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'INNER' })).toBeInTheDocument());
  });

  it('applies the declared default when the page is reached by navigation', async () => {
    // Nothing supplies values outside the Open Page Overlay action, so the
    // page's own scope is the only thing standing between a declared default
    // and a blank widget. The overlay suite cannot cover this: `ModalStack`
    // merges the defaults in itself before the page ever renders.
    render(
      <MemoryRouter>
        <PageGroupPageView
          pages={[paramPage()]}
          requestedId="detail"
          onNavigate={() => {}}
          takesInputs
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'M1' })).toBeInTheDocument());
  });
});
