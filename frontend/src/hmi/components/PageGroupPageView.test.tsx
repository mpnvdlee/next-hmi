import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useConfigStore } from '@shared/store/configStore';
import { useVariableStore } from '@hmi/store/variableStore';
import { useHmiStore } from '@hmi/store/hmiStore';
import type { PageConfig, PageGroupConfig } from '@shared/types/config';
import { widgetRegistry } from '@hmi/registry/widgetRegistry';
import { LabeledProbe } from './__fixtures__/probeWidgets';
import { useEvalContext } from '@hmi/hooks/useEvalContext';
import PageGroupPageView from './PageGroupPageView';
import { usePageEvents } from '@hmi/hooks/usePageEvents';

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

describe('PageGroupPageView / inputs a Navigate To Page passes', () => {
  // The line group declares `shift`, its page `a` declares `filter`; `b` sits
  // in the same group, `other` outside it.
  function probe(id: string, name: string) {
    return {
      id,
      type: 'LabeledProbe',
      name: 'Probe',
      properties: { label: { $componentProp: name } },
    };
  }
  const value = (label: string, defaultValue: string) => ({
    type: 'String',
    label,
    defaultValue,
    mode: 'value',
  });
  const pages = [
    {
      id: 'line',
      title: 'Line',
      type: 'page-group',
      componentProperties: { shift: value('Shift', 'day') },
      children: [
        {
          id: 'a',
          title: 'A',
          type: 'page',
          componentProperties: { filter: value('Filter', 'all') },
          sections: { content: [probe('pf', 'filter'), probe('ps', 'shift')] },
        },
        { id: 'b', title: 'B', type: 'page', sections: { content: [probe('ps', 'shift')] } },
      ],
    },
    { id: 'other', title: 'Other', type: 'page', sections: { content: [] } },
  ] as unknown as PageGroupConfig[];

  function View({ id }: { id: string }) {
    return (
      <MemoryRouter>
        <PageGroupPageView pages={pages} requestedId={id} onNavigate={() => {}} readsArrivals />
      </MemoryRouter>
    );
  }
  const shows = (name: string) =>
    waitFor(() => expect(screen.getByRole('button', { name })).toBeInTheDocument());
  /** What a Navigate To Page queues: the route change goes through the router,
   *  which these tests stand in for by re-rendering with the new id. */
  const navigate = (pageId: string, values: Record<string, unknown> = {}) =>
    act(() => useHmiStore.getState().navigateToPage(pageId, undefined, values));

  beforeEach(() => {
    useConfigStore.setState({ loadedPageIds: new Set(['a', 'b', 'other']) });
    useHmiStore.setState({ pageArrival: null });
    widgetRegistry.LabeledProbe = LabeledProbe;
  });

  afterEach(() => {
    delete widgetRegistry.LabeledProbe;
  });

  it('reads what it passed on arrival, and starts at defaults when nothing passed it', async () => {
    const { rerender } = render(<View id="other" />);
    navigate('a', { filter: 'Espresso' });
    rerender(<View id="a" />);
    await shows('Espresso');
    expect(useHmiStore.getState().pageArrival).toBeNull();
    // (a) A menu, a tab or the browser's back button passes nothing.
    rerender(<View id="other" />);
    rerender(<View id="a" />);
    await shows('all');
  });

  it('reads again on the page it is already on, an empty input at its default', async () => {
    render(<View id="a" />);
    await shows('all');
    navigate('a', { filter: 'Espresso' });
    await shows('Espresso');
    // (c) The same values again are read again; a left-out input is the default.
    navigate('a', { shift: 'night' });
    await shows('night');
    await shows('all');
  });

  it('keeps a group’s input while moving inside the group, and forgets it on leaving', async () => {
    const { rerender } = render(<View id="other" />);
    navigate('a', { shift: 'night' });
    rerender(<View id="a" />);
    await shows('night');
    // (b) Moving to a sibling page by a tab passes nothing, and keeps it.
    rerender(<View id="b" />);
    await shows('night');
    // A Navigate To Page that leaves it empty keeps it too.
    navigate('a');
    rerender(<View id="a" />);
    await shows('night');
    rerender(<View id="other" />);
    rerender(<View id="b" />);
    await shows('day');
  });

  it('is not kept anywhere a refresh would find it', async () => {
    const { unmount } = render(<View id="other" />);
    navigate('a', { filter: 'Espresso' });
    unmount();
    // (d) Nothing goes in the URL; a fresh view still reads a pending arrival
    // once, and after that one a fresh view starts at defaults.
    const first = render(<View id="a" />);
    await shows('Espresso');
    first.unmount();
    render(<View id="a" />);
    await shows('all');
  });
});

describe('PageGroupPageView / a routed page’s events read its inputs', () => {
  const toast = (event: string) => ({
    type: 'showToast',
    message: {
      $stringExpr: { template: `${event} {1}`, wildcards: { 1: { $componentProp: 'filter' } } },
    },
  });
  const pages = [
    {
      id: 'a',
      title: 'A',
      type: 'page',
      componentProperties: {
        filter: { type: 'String', label: 'Filter', defaultValue: 'all', mode: 'value' },
      },
      events: { onOpen: [toast('open')], onClose: [toast('close')] },
      sections: { content: [] },
    },
    { id: 'other', title: 'Other', type: 'page', sections: { content: [] } },
  ] as unknown as PageConfig[];

  // HmiView's arrangement: the events hook in the parent, on the rendered id,
  // and the page view mounted only once the boot screen is gone.
  function View({ id, booted = true }: { id: string; booted?: boolean }) {
    usePageEvents('runtime:test', id);
    return booted ? (
      <PageGroupPageView pages={pages} requestedId={id} onNavigate={() => {}} readsArrivals />
    ) : null;
  }
  const toasts = () => useHmiStore.getState().pendingToasts.map((t) => t.message);

  beforeEach(() => {
    useConfigStore.setState({ pages, loadedPageIds: new Set(['a', 'other']) });
    useHmiStore.setState({ pageArrival: null, pendingToasts: [], routedInputScopes: {} });
  });

  it('opens with what Navigate To Page passed and closes with the local value', () => {
    const { rerender } = render(
      <MemoryRouter>
        <View id="other" />
      </MemoryRouter>,
    );
    act(() => useHmiStore.getState().navigateToPage('a', undefined, { filter: 'Espresso' }));
    rerender(
      <MemoryRouter>
        <View id="a" />
      </MemoryRouter>,
    );
    expect(toasts()).toEqual(['open Espresso']);

    // The page changes its own copy, as a String Input would.
    const slot = (useHmiStore.getState().routedInputScopes.a.filter as { $var: { path: string } })
      .$var.path;
    act(() => useVariableStore.getState().setScalar(slot, 'Doos'));
    rerender(
      <MemoryRouter>
        <View id="other" />
      </MemoryRouter>,
    );
    expect(toasts()).toEqual(['open Espresso', 'close Doos']);
    expect(useVariableStore.getState().values[slot]).toBeUndefined();
  });

  it('opens at the defaults on a first load, behind the boot screen', () => {
    const { rerender } = render(
      <MemoryRouter>
        <View id="a" booted={false} />
      </MemoryRouter>,
    );
    expect(toasts()).toEqual([]);
    rerender(
      <MemoryRouter>
        <View id="a" />
      </MemoryRouter>,
    );
    expect(toasts()).toEqual(['open all']);
  });
});
