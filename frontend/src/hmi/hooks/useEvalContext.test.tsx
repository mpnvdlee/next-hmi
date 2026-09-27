import { act, render, renderHook, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useConfigStore } from '@shared/store/configStore';
import { HostPageContext } from '../context/HostPageContext';
import { useEvalContext } from './useEvalContext';

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
