import { renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useConfigStore } from '@shared/store/configStore';
import { useEvalContext } from './useEvalContext';

const PAGES = [
  { id: 'dashboard', type: 'page' as const, title: 'Dashboard', description: 'Line overview' },
  { id: 'line', type: 'page' as const, title: 'Filling Line', description: 'Station detail' },
];

function wrapper(initialPath: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <MemoryRouter initialEntries={[initialPath]}>{children}</MemoryRouter>;
  };
}

describe('useEvalContext $page resolution', () => {
  beforeEach(() => {
    useConfigStore.setState({ pages: PAGES as never });
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

  it('returns null when the project has no pages at all', () => {
    useConfigStore.setState({ pages: [] });
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
