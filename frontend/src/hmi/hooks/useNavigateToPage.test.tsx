import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { PreviewContext } from '@shared/context/PreviewContext';
import { setPageAnnouncer } from '@hmi/utils/pageAnnouncer';
import { useNavigateToPage } from './useNavigateToPage';

function wrapper(preview: boolean) {
  return ({ children }: { children: ReactNode }) => (
    <PreviewContext.Provider value={preview}>
      <MemoryRouter initialEntries={['/pages/brew']}>{children}</MemoryRouter>
    </PreviewContext.Provider>
  );
}

function useNavigation() {
  return { navigateToPage: useNavigateToPage(), path: useLocation().pathname };
}

afterEach(() => setPageAnnouncer(null));

// The page asked for its values only once it had been built and drawn, so a
// widget whose Visible reads a hidden tag showed until they arrived.
describe('useNavigateToPage', () => {
  it('asks for the page before the route moves to it', () => {
    const seen: string[] = [];
    const { result } = renderHook(useNavigation, { wrapper: wrapper(false) });
    setPageAnnouncer((pageId) => seen.push(`${pageId} from ${result.current.path}`));

    act(() => result.current.navigateToPage('slaves'));

    expect(seen).toEqual(['slaves from /pages/brew']);
    expect(result.current.path).toBe('/pages/slaves');
  });

  it('asks for nothing in the editor preview, which keeps its own context', () => {
    const announce = vi.fn();
    const { result } = renderHook(useNavigation, { wrapper: wrapper(true) });
    setPageAnnouncer(announce);

    act(() => result.current.navigateToPage('slaves'));

    expect(announce).not.toHaveBeenCalled();
    expect(result.current.path).toBe('/preview/slaves');
  });
});
