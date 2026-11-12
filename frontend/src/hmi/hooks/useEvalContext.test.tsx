import { act, render, renderHook, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useConfigStore } from '@shared/store/configStore';
import { HostPageContext } from '../context/HostPageContext';
import { PageGroupStackContext } from '../components/PageGroupStackContext';
import { useHmiStore } from '../store/hmiStore';
import { evaluatePropertyValue } from '../utils/propertySourceEval';
import { useEvalContext, WidgetStoresContext } from './useEvalContext';
import { useReactiveEval } from './useReactiveEval';
import { useComponentPropStore } from '../store/widgetPropStore';

const PAGES = [
  { id: 'dashboard', type: 'page' as const, title: 'Dashboard', description: 'Line overview' },
  { id: 'line', type: 'page' as const, title: 'Filling Line', description: 'Station detail' },
];

function wrapper(initialPath: string, hostPageId?: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter initialEntries={[initialPath]}>
        <HostPageContext.Provider value={hostPageId}>{children}</HostPageContext.Provider>
      </MemoryRouter>
    );
  };
}

describe('useEvalContext $page resolution', () => {
  beforeEach(() => {
    useConfigStore.setState({ pages: PAGES as never, dialogs: [] });
  });

  it('resolves the named page on a /pages/<id> route', () => {
    const { result } = renderHook(() => useEvalContext(), { wrapper: wrapper('/pages/line') });
    expect(result.current.resolvePage?.('title')).toBe('Filling Line');
    expect(result.current.resolvePage?.('description')).toBe('Station detail');
  });

  it('falls back to the first page on the index route, which is what gets rendered there', () => {
    const { result } = renderHook(() => useEvalContext(), { wrapper: wrapper('/') });
    expect(result.current.resolvePage?.('title')).toBe('Dashboard');
    expect(result.current.resolvePage?.('description')).toBe('Line overview');
  });

  it('still honours an explicit pageId over the route', () => {
    const { result } = renderHook(() => useEvalContext(), { wrapper: wrapper('/') });
    expect(result.current.resolvePage?.('title', 'line')).toBe('Filling Line');
  });

  it('resolves the page being rendered, not the route, when they disagree', () => {
    // A page overlay renders a page without touching the URL. `$page` has to
    // report the page the widget is actually inside, or a gate keyed on it
    // silently matches the host page behind the overlay.
    const { result } = renderHook(() => useEvalContext(), {
      wrapper: wrapper('/pages/dashboard', 'line'),
    });
    expect(result.current.resolvePage?.('id')).toBe('line');
    expect(result.current.resolvePage?.('title')).toBe('Filling Line');
  });

  it('resolves the breadcrumb trail of the rendered page, not the route', () => {
    const { result } = renderHook(() => useEvalContext(), {
      wrapper: wrapper('/pages/dashboard', 'line'),
    });
    expect(result.current.resolvePagePath?.().map((s) => s.id)).toEqual(['line']);
  });

  it('resolves a page of the Dialogs folder, which is in the other root', () => {
    // An overlay publishes its own page as the host, and a Dialogs-folder page
    // is not in the navigable tree — resolving against `pages` alone leaves
    // every `$page` field null inside it.
    useConfigStore.setState({
      dialogs: [
        {
          id: 'motor-detail',
          type: 'page',
          title: 'Motor detail',
          description: 'Overlay',
          sections: { content: [] },
        },
      ] as never,
    });
    const { result } = renderHook(() => useEvalContext(), {
      wrapper: wrapper('/pages/dashboard', 'motor-detail'),
    });
    expect(result.current.resolvePage?.('title')).toBe('Motor detail');
    expect(result.current.resolvePagePath?.().map((s) => s.id)).toEqual(['motor-detail']);
  });

  it('re-renders a consumer when a Dialogs-folder page it resolves is edited', () => {
    // The resolvers read the store fresh, so what makes a `$page` consumer show
    // a new title is the hook's own subscription — and that has to cover both
    // roots now that it resolves both. No forced re-render here: the store
    // update is the only thing that may drive it.
    useConfigStore.setState({
      dialogs: [
        { id: 'motor-detail', type: 'page', title: 'Motor detail', sections: { content: [] } },
      ] as never,
    });
    function PageTitle() {
      const ctx = useEvalContext();
      return <span data-testid="title">{String(ctx.resolvePage?.('title') ?? '')}</span>;
    }
    const Wrapper = wrapper('/pages/dashboard', 'motor-detail');
    render(
      <Wrapper>
        <PageTitle />
      </Wrapper>,
    );
    expect(screen.getByTestId('title').textContent).toBe('Motor detail');

    act(() => {
      useConfigStore.getState().updatePage('motor-detail', { title: 'Motor detail v2' });
    });

    expect(screen.getByTestId('title').textContent).toBe('Motor detail v2');
  });

  it('returns null when the project has no pages at all', () => {
    useConfigStore.setState({ pages: [], dialogs: [] });
    const { result } = renderHook(() => useEvalContext(), { wrapper: wrapper('/') });
    expect(result.current.resolvePage?.('title')).toBeNull();
  });
});

describe('useEvalContext $pageIsActive', () => {
  beforeEach(() => {
    useConfigStore.setState({ pages: PAGES as never });
  });

  it('reports the named page on a /pages/<id> route', () => {
    const { result } = renderHook(() => useEvalContext(), { wrapper: wrapper('/pages/line') });
    expect(result.current.isPageActive?.('line')).toBe(true);
    expect(result.current.isPageActive?.('dashboard')).toBe(false);
  });

  it('reports the landing page as active on the index route', () => {
    // It is the page being rendered there, so a menu highlight or an `$if`
    // gated on it must agree with `$page`, which resolves the same fallback.
    const { result } = renderHook(() => useEvalContext(), { wrapper: wrapper('/') });
    expect(result.current.isPageActive?.('dashboard')).toBe(true);
    expect(result.current.isPageActive?.('line')).toBe(false);
  });
});

describe('useEvalContext $overlay', () => {
  beforeEach(() => {
    useConfigStore.setState({
      pages: PAGES as never,
      dialogs: [
        {
          id: 'device',
          type: 'page',
          title: 'Device',
          componentProperties: {
            device: { type: 'Integer' },
            mode: { type: 'String', defaultValue: 'view' },
          },
          sections: { content: [] },
        },
      ] as never,
    });
    useHmiStore.setState({ openPageOverlays: [] });
  });

  function Ring() {
    const ctx = useEvalContext();
    const value = evaluatePropertyValue({ $overlay: { page: 'device', param: 'device' } }, ctx);
    return <span data-testid="ring">{String(value)}</span>;
  }

  it('reads the input of the open dialog and follows it opening, swapping and closing', () => {
    const Wrapper = wrapper('/pages/dashboard');
    render(
      <Wrapper>
        <Ring />
      </Wrapper>,
    );
    expect(screen.getByTestId('ring').textContent).toBe('null');

    const open = (device: number) =>
      act(() => {
        useHmiStore.getState().openPageOverlay({
          pageId: 'device',
          componentProperties: { device },
          size: 'auto',
          placement: 'center',
        });
      });
    open(3);
    expect(screen.getByTestId('ring').textContent).toBe('3');
    open(4);
    expect(screen.getByTestId('ring').textContent).toBe('4');

    act(() => useHmiStore.getState().closePageOverlay('device'));
    expect(screen.getByTestId('ring').textContent).toBe('null');
  });

  it('falls back to the declared default for an input the opener left out', () => {
    useHmiStore.setState({
      openPageOverlays: [
        { pageId: 'device', componentProperties: {}, size: 'auto', placement: 'center' },
      ],
    });
    const { result } = renderHook(() => useEvalContext(), { wrapper: wrapper('/pages/line') });
    expect(result.current.resolveOverlayParam?.('device', 'mode')).toBe('view');
    expect(result.current.resolveOverlayParam?.('other', 'mode')).toBeNull();
  });
});

describe('useEvalContext $page groupIndex / groupLastIndex', () => {
  const scope = { id: 'scope', type: 'page' as const, title: 'Scope' };
  const params = { id: 'params', type: 'page' as const, title: 'Params' };
  const info = { id: 'info', type: 'page' as const, title: 'Info' };
  const device = {
    id: 'device',
    type: 'page-group' as const,
    title: 'Device',
    children: [scope, params, info],
  };

  beforeEach(() => {
    useConfigStore.setState({ pages: [device] as never, dialogs: [] });
  });

  it('reads the active tab of the group the widget sits in, counted from 0', () => {
    const stack = [{ group: device, activePage: params, onNavigate: () => {} }] as never;
    const { result } = renderHook(() => useEvalContext(), {
      wrapper: ({ children }) => (
        <MemoryRouter initialEntries={['/pages/params']}>
          <PageGroupStackContext.Provider value={stack}>{children}</PageGroupStackContext.Provider>
        </MemoryRouter>
      ),
    });
    expect(result.current.resolvePage?.('groupIndex')).toBe(1);
    expect(result.current.resolvePage?.('groupLastIndex')).toBe(2);
  });

  it("reads a named page's own position, and nothing for a page outside a group", () => {
    useConfigStore.setState({
      pages: [device, { id: 'home', type: 'page', title: 'Home' }] as never,
    });
    const { result } = renderHook(() => useEvalContext(), { wrapper: wrapper('/pages/home') });
    expect(result.current.resolvePage?.('groupIndex', 'info')).toBe(2);
    expect(result.current.resolvePage?.('groupLastIndex', 'info')).toBe(2);
    expect(result.current.resolvePage?.('groupIndex')).toBeNull();
  });
});

// A popup a widget opens, the alarm detail dialog of an alarm list, renders
// inside that widget, whose stores say nothing about the popup's values.
describe('useReactiveEval inside a widget', () => {
  const SELECTED = { $widgetProp: { componentId: 'grid', property: 'row' } };

  function Popup() {
    const value = evaluatePropertyValue(SELECTED, useReactiveEval(SELECTED));
    return <span data-testid="popup">{String(value)}</span>;
  }

  it('follows the stores of the values it is given', () => {
    useComponentPropStore.setState({ props: {} });
    const Wrapper = wrapper('/pages/dashboard');
    render(
      <Wrapper>
        <WidgetStoresContext.Provider value={0}>
          <Popup />
        </WidgetStoresContext.Provider>
      </Wrapper>,
    );
    act(() => useComponentPropStore.getState().setComponentProp('grid', 'row', 4));
    expect(screen.getByTestId('popup').textContent).toBe('4');
  });
});
