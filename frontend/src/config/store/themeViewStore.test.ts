import { useProjectStore } from '@shared/store/projectStore';
import { useThemeViewStore } from './themeViewStore';
import type { ThemeConfig } from '@shared/types/theme';

const SAMPLE: ThemeConfig = {
  colors: {
    bg: '#f5f8fa',
    surface: '#ffffff',
    surface_raised: '#edf3f8',
    text: '#1f2937',
    text_muted: '#6b7280',
    accent: '#2d9cff',
    border: '#d6dee2',
    ok: '#1fbf75',
    warn: '#f2a93b',
    fault: '#e74c3c',
  },
  typography: {
    heading_font: "'Inter', system-ui, sans-serif",
    heading_size: '1.25rem',
    heading_weight: 600,
    heading_tracking: '-0.02em',
    heading_transform: 'none',
    subheading_font: "'Inter', system-ui, sans-serif",
    subheading_size: '1rem',
    subheading_weight: 600,
    subheading_tracking: '0',
    subheading_transform: 'none',
    body_font: "'Inter', system-ui, sans-serif",
    body_size: '0.875rem',
    body_weight: 400,
    body_tracking: '-0.005em',
    body_transform: 'none',
    caption_font: "'Inter', system-ui, sans-serif",
    caption_size: '0.75rem',
    caption_weight: 400,
    caption_tracking: '0',
    caption_transform: 'none',
    code_font: "'Roboto Mono', 'Courier New', monospace",
    code_size: '0.875rem',
    code_weight: 400,
    code_tracking: '0',
    code_transform: 'none',
    value_font: "'Inter', system-ui, sans-serif",
    value_size: '1.75rem',
    value_weight: 700,
    value_tracking: '0',
    value_transform: 'none',
    label_font: "'Inter', system-ui, sans-serif",
    label_size: '0.75rem',
    label_weight: 700,
    label_tracking: '0.06em',
    label_transform: 'uppercase',
  },
  spacing: {
    space_sm: '0.5rem',
    space_md: '0.75rem',
    space_lg: '1rem',
    radius_sm: '4px',
    radius_md: '6px',
    radius_lg: '8px',
    shadow: '0 4px 16px rgba(0,0,0,0.12)',
  },
};

describe('themeViewStore', () => {
  beforeEach(() => {
    useThemeViewStore.setState({
      themeIds: ['light'],
      defaultThemeId: 'light',
      selectedThemeId: 'light',
      loaded: { light: SAMPLE },
      drafts: {},
      loading: false,
      loadError: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('load() populates ids, default, and selection from the index', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/themes') {
          return {
            ok: true,
            json: async () => ({
              default: 'dark',
              themes: [
                { id: 'light', config: SAMPLE },
                { id: 'dark', config: SAMPLE },
              ],
            }),
          };
        }
        return { ok: true, json: async () => ({}) };
      }),
    );

    useThemeViewStore.setState({ selectedThemeId: '' });
    document.documentElement.style.removeProperty('--hmi-accent');
    await useThemeViewStore.getState().load();

    const s = useThemeViewStore.getState();
    expect(s.themeIds).toEqual(['light', 'dark']);
    expect(s.defaultThemeId).toBe('dark');
    expect(s.selectedThemeId).toBe('dark');
    // Nothing else on the themes route applies tokens — load() must, or the
    // page previews render the built-in fallback palette.
    expect(document.documentElement.style.getPropertyValue('--hmi-accent')).toBe(
      SAMPLE.colors.accent,
    );
  });

  it('updateSection writes a draft and marks the project dirty', () => {
    useProjectStore.setState({ dirty: false });
    useThemeViewStore.getState().updateSection('colors', { accent: '#000000' });

    const s = useThemeViewStore.getState();
    expect(s.drafts.light?.colors.accent).toBe('#000000');
    expect(useProjectStore.getState().dirty).toBe(true);
  });

  it('undo/redo reverts and reapplies a theme edit via the shared project history', () => {
    useProjectStore.setState({ past: [], future: [], dirty: false });
    // Capture the clean (no-draft) baseline, then edit.
    useProjectStore.getState().pushSnapshot();
    useThemeViewStore.getState().updateSection('colors', { accent: '#123456' });
    expect(useThemeViewStore.getState().drafts.light?.colors.accent).toBe('#123456');

    useProjectStore.getState().undo();
    expect(useThemeViewStore.getState().drafts.light).toBeUndefined();

    useProjectStore.getState().redo();
    expect(useThemeViewStore.getState().drafts.light?.colors.accent).toBe('#123456');
  });

  it('save callback PUTs each dirty draft and surfaces backend errors', async () => {
    useThemeViewStore.setState({ drafts: { light: SAMPLE } });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, opts?: RequestInit) => {
        if (url === '/api/themes/light' && opts?.method === 'PUT') {
          return { ok: false, json: async () => ({ detail: 'save exploded' }) };
        }
        return { ok: true, json: async () => ({}) };
      }),
    );

    const saveTheme = useProjectStore.getState()._saveCallbacks.get('theme');
    expect(saveTheme).toBeTruthy();
    await expect(saveTheme?.()).rejects.toThrow('save exploded');
  });

  it('save callback is a no-op when there are no drafts', async () => {
    useThemeViewStore.setState({ drafts: {} });
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);

    const saveTheme = useProjectStore.getState()._saveCallbacks.get('theme');
    await saveTheme?.();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
