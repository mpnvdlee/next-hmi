import { act, render, screen } from '@testing-library/react';
import ThemesView from './ThemesView';
import { useThemeViewStore } from '../store/themeViewStore';
import type { ThemeConfig } from '@shared/types/theme';

vi.mock('../components/themes/ThemeTree', () => ({ default: () => <div data-testid="tree" /> }));
vi.mock('../components/themes/ThemeEditor', () => ({
  default: ({ theme, error }: { theme: ThemeConfig; error: string | null }) => (
    <div data-testid="editor">
      <span data-testid="editor-name">{theme.colors.bg}</span>
      <span data-testid="editor-error">{error ?? ''}</span>
    </div>
  ),
}));

const DARK = { colors: { bg: '#000000' } } as unknown as ThemeConfig;
const LIGHT = { colors: { bg: '#ffffff' } } as unknown as ThemeConfig;

const INITIAL = useThemeViewStore.getState();

function stubValidation(result: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => result,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.useFakeTimers();
  useThemeViewStore.setState({
    themeIds: ['dark', 'light'],
    defaultThemeId: 'dark',
    selectedThemeId: 'dark',
    loaded: { dark: DARK, light: LIGHT },
    drafts: {},
    loading: false,
    loadError: null,
    load: vi.fn().mockResolvedValue(undefined),
  });
  stubValidation({ errors: [] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useThemeViewStore.setState(INITIAL);
});

describe('ThemesView', () => {
  it('loads the theme index on mount', () => {
    const load = vi.fn().mockResolvedValue(undefined);
    useThemeViewStore.setState({ load });

    render(<ThemesView />);

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('shows a spinner while the index is loading', () => {
    useThemeViewStore.setState({ loading: true });

    const { container } = render(<ThemesView />);

    expect(container.querySelector('.app-spinner')).not.toBeNull();
    expect(screen.queryByTestId('editor')).toBeNull();
  });

  it('shows the load error in place of the editor', () => {
    useThemeViewStore.setState({ loadError: 'Could not load themes.' });

    render(<ThemesView />);

    expect(screen.getByText('Could not load themes.')).toBeInTheDocument();
    expect(screen.queryByTestId('tree')).toBeNull();
  });

  it('edits the selected theme', () => {
    render(<ThemesView />);

    expect(screen.getByTestId('editor-name')).toHaveTextContent('#000000');
  });

  it('prefers a dirty draft over the last-saved config', () => {
    useThemeViewStore.setState({
      drafts: { dark: { colors: { bg: '#123456' } } as unknown as ThemeConfig },
    });

    render(<ThemesView />);

    expect(screen.getByTestId('editor-name')).toHaveTextContent('#123456');
  });

  it('prompts for a selection when the index is empty', () => {
    useThemeViewStore.setState({ themeIds: [], loaded: {}, selectedThemeId: '' });

    render(<ThemesView />);

    expect(screen.getByText('Select a theme to edit.')).toBeInTheDocument();
    expect(screen.queryByTestId('editor')).toBeNull();
  });

  it('debounces validation rather than posting on every keystroke', async () => {
    const fetchMock = stubValidation({ errors: [] });
    render(<ThemesView />);

    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(399);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/themes/dark/validate');
  });

  it('surfaces structured validation errors as one joined message', async () => {
    stubValidation({
      errors: [{ message: 'colors.bg is not a color' }, { message: 'spacing.md must be a length' }],
    });
    render(<ThemesView />);

    await act(() => vi.advanceTimersByTimeAsync(400));

    expect(screen.getByTestId('editor-error')).toHaveTextContent(
      'colors.bg is not a color, spacing.md must be a length',
    );
  });

  it('clears the error once a later validation passes', async () => {
    stubValidation({ errors: [{ message: 'colors.bg is not a color' }] });
    render(<ThemesView />);
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(screen.getByTestId('editor-error')).not.toBeEmptyDOMElement();

    stubValidation({ errors: [] });
    act(() => {
      useThemeViewStore.setState({
        drafts: { dark: { colors: { bg: '#111111' } } as unknown as ThemeConfig },
      });
    });
    await act(() => vi.advanceTimersByTimeAsync(400));

    expect(screen.getByTestId('editor-error')).toBeEmptyDOMElement();
  });

  it('reports a failed validation request instead of leaving the editor stale', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }),
    );
    render(<ThemesView />);

    await act(() => vi.advanceTimersByTimeAsync(400));

    expect(screen.getByTestId('editor-error')).toHaveTextContent('HTTP 500');
  });

  it('does not validate when no theme is selected', async () => {
    const fetchMock = stubValidation({ errors: [] });
    useThemeViewStore.setState({ themeIds: [], loaded: {}, selectedThemeId: '' });
    render(<ThemesView />);

    await vi.advanceTimersByTimeAsync(1000);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops an in-flight validation when the view unmounts', async () => {
    const fetchMock = stubValidation({ errors: [] });
    const view = render(<ThemesView />);

    view.unmount();
    await vi.advanceTimersByTimeAsync(1000);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
