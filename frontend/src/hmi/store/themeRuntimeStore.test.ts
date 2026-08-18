import { useThemeRuntimeStore } from './themeRuntimeStore';
import {
  applyThemeById,
  loadAndApplyThemeTokens,
  setLoadedThemes,
} from '@shared/utils/themeTokens';
import type { ThemeConfig } from '@shared/types/theme';

function theme(accent: string): ThemeConfig {
  return {
    colors: {
      bg: '#000',
      surface: '#111',
      surface_raised: '#222',
      text: '#fff',
      text_muted: '#ccc',
      accent,
      border: '#333',
      ok: '#0f0',
      warn: '#ff0',
      fault: '#f00',
    },
    typography: {
      heading_font: 'Inter',
      heading_size: '1rem',
      heading_weight: 600,
      heading_tracking: '0',
      heading_transform: 'none',
      subheading_font: 'Inter',
      subheading_size: '1rem',
      subheading_weight: 600,
      subheading_tracking: '0',
      subheading_transform: 'none',
      body_font: 'Inter',
      body_size: '1rem',
      body_weight: 400,
      body_tracking: '0',
      body_transform: 'none',
      caption_font: 'Inter',
      caption_size: '1rem',
      caption_weight: 400,
      caption_tracking: '0',
      caption_transform: 'none',
      code_font: 'Inter',
      code_size: '1rem',
      code_weight: 400,
      code_tracking: '0',
      code_transform: 'none',
      value_font: 'Inter',
      value_size: '1rem',
      value_weight: 700,
      value_tracking: '0',
      value_transform: 'none',
      label_font: 'Inter',
      label_size: '1rem',
      label_weight: 700,
      label_tracking: '0',
      label_transform: 'none',
    },
    spacing: {
      space_sm: '0.5rem',
      space_md: '0.75rem',
      space_lg: '1rem',
      radius_sm: '4px',
      radius_md: '6px',
      radius_lg: '8px',
      shadow: 'none',
    },
  };
}

describe('themeRuntimeStore', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    setLoadedThemes({}, '');
  });

  it('setActiveTheme applies an already-loaded theme and updates state immediately', () => {
    setLoadedThemes({ light: theme('#2d9cff'), dark: theme('#ff8800') }, 'light');

    useThemeRuntimeStore.getState().setActiveTheme('dark');

    expect(useThemeRuntimeStore.getState().activeThemeId).toBe('dark');
    expect(document.documentElement.style.getPropertyValue('--hmi-accent')).toBe('#ff8800');
  });

  it('does not change state when setActiveTheme targets an id that never loads', async () => {
    setLoadedThemes({ light: theme('#2d9cff') }, 'light');
    useThemeRuntimeStore.setState({ activeThemeId: 'light' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          default: 'light',
          themes: [{ id: 'light', config: theme('#2d9cff') }],
        }),
      })),
    );

    useThemeRuntimeStore.getState().setActiveTheme('nonexistent');
    await vi.waitFor(() => {
      expect(useThemeRuntimeStore.getState().activeThemeId).toBe('light');
    });
  });

  it('ensureThemeTokens retries after a cold-backend failure, then stops once loaded', async () => {
    // Fresh module instance so the "already loaded" latch starts clear.
    vi.resetModules();
    const tokens = await import('@shared/utils/themeTokens');
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        // The manager proxy answers 503 until the project instance is serving.
        if (calls === 1) return { ok: false, status: 503, json: async () => ({ detail: 'boot' }) };
        return {
          ok: true,
          json: async () => ({
            default: 'light',
            themes: [{ id: 'light', config: theme('#2d9cff') }],
          }),
        };
      }),
    );
    document.documentElement.style.removeProperty('--hmi-accent');

    // Startup: the fetch fails and leaves whatever tokens are on the document.
    await tokens.ensureThemeTokens();
    expect(document.documentElement.style.getPropertyValue('--hmi-accent')).toBe('');

    // The WebSocket opening proves the backend is serving — AppInner re-asks.
    await tokens.ensureThemeTokens();
    expect(document.documentElement.style.getPropertyValue('--hmi-accent')).toBe('#2d9cff');

    // Loaded now, so later signals (a reconnect) cost no further round-trips.
    await tokens.ensureThemeTokens();
    expect(calls).toBe(2);
  });

  it('a background load does not repaint over the editor preview pin', async () => {
    // Fresh module instance: the pin is per-document (only the preview iframe
    // sets it) and must not leak into the sibling tests here.
    vi.resetModules();
    const tokens = await import('@shared/utils/themeTokens');
    tokens.applyPreviewTheme(theme('#ff8800'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          default: 'light',
          themes: [{ id: 'light', config: theme('#2d9cff') }],
        }),
      })),
    );

    await tokens.loadAndApplyThemeTokens({ force: true });

    // Index cached for the editor, document still showing the unsaved draft.
    expect(tokens.getLoadedThemes().light?.colors.accent).toBe('#2d9cff');
    expect(document.documentElement.style.getPropertyValue('--hmi-accent')).toBe('#ff8800');
  });

  it('syncActiveTheme realigns to the default after a cross-tab save deletes the active theme', async () => {
    setLoadedThemes({ light: theme('#2d9cff'), dark: theme('#ff8800') }, 'light');
    applyThemeById('dark');
    useThemeRuntimeStore.setState({ activeThemeId: 'dark' });

    // Cross-tab save removed "dark" — AppInner's storage listener force-reloads
    // the index and then resyncs the store to whatever actually got applied.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          default: 'light',
          themes: [{ id: 'light', config: theme('#2d9cff') }],
        }),
      })),
    );
    await loadAndApplyThemeTokens({ force: true });

    useThemeRuntimeStore.getState().syncActiveTheme();

    expect(useThemeRuntimeStore.getState().activeThemeId).toBe('light');
    expect(document.documentElement.style.getPropertyValue('--hmi-accent')).toBe('#2d9cff');
  });
});
