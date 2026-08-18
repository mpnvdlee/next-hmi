import { create } from 'zustand';
import type { ThemeConfig, ThemeEnvelope, ThemesIndex } from '@shared/types/theme';
import { useProjectStore } from '@shared/store/projectStore';
import { apiJson } from '@shared/utils/api';
import {
  applyThemeTokens,
  defaultTheme,
  getLoadedThemes,
  setLoadedThemes,
  LS_THEME_PREVIEW,
  LS_THEME_SAVED,
  type ThemeSection,
} from '@shared/utils/themeTokens';

interface ThemeViewStore {
  /** Theme ids in display order. */
  themeIds: string[];
  /** Author-chosen default theme id. */
  defaultThemeId: string;
  /** Theme currently open in the editor. */
  selectedThemeId: string;
  /** Last-saved configs, keyed by id. */
  loaded: Record<string, ThemeConfig>;
  /** Dirty working copies, keyed by id (only present once edited). */
  drafts: Record<string, ThemeConfig>;
  loading: boolean;
  loadError: string | null;

  load(): Promise<void>;
  select(id: string): void;
  /** Active config for the selected theme: draft if dirty, else last-saved. */
  activeConfig(): ThemeConfig | null;
  updateSection(section: ThemeSection, patch: Record<string, unknown>): void;
  resetSection(section: ThemeSection): void;
  createTheme(name: string, sourceId?: string): Promise<void>;
  deleteTheme(id: string): Promise<void>;
  setDefaultTheme(id: string): Promise<void>;
}

/** Throttled undo snapshot for high-frequency edits (color drags, typing). */
let _lastSnapshot = 0;
function snapshotThrottled(ms = 400): void {
  const now = Date.now();
  if (now - _lastSnapshot > ms) {
    useProjectStore.getState().pushSnapshot();
    _lastSnapshot = now;
  }
}

function broadcastPreview(theme: ThemeConfig): void {
  applyThemeTokens(theme);
  try {
    localStorage.setItem(LS_THEME_PREVIEW, JSON.stringify({ ts: Date.now(), theme }));
  } catch {
    // Local preview still updated the CSS vars; cross-tab sync is best-effort.
  }
}

export const useThemeViewStore = create<ThemeViewStore>((set, get) => ({
  themeIds: [],
  defaultThemeId: '',
  selectedThemeId: '',
  loaded: {},
  drafts: {},
  loading: true,
  loadError: null,

  load: async () => {
    set({ loading: true, loadError: null });
    try {
      const index = await apiJson<ThemesIndex>('/api/themes');
      const loaded: Record<string, ThemeConfig> = {};
      for (const t of index.themes) loaded[t.id] = t.config;
      const themeIds = index.themes.map((t) => t.id);
      const current = get().selectedThemeId;
      const selectedThemeId =
        current && themeIds.includes(current) ? current : index.default || themeIds[0] || '';
      set({
        themeIds,
        defaultThemeId: index.default,
        loaded,
        selectedThemeId,
        loading: false,
      });
      // Keep the runtime cache in sync off this same fetch so mutations don't
      // need a second /api/themes round-trip.
      setLoadedThemes(loaded, index.default);
      // Apply the selected theme's tokens: nothing else on the themes route
      // loads them, so without this the page previews (typography specimens,
      // spacing/radius shapes, every `--hmi-*` consumer) keep rendering the
      // built-in fallback palette until another view happens to apply one.
      const active = get().activeConfig();
      if (active) applyThemeTokens(active);
    } catch (err) {
      set({
        loading: false,
        loadError: err instanceof Error ? err.message : 'Failed to load themes',
      });
    }
  },

  select: (id) => {
    set({ selectedThemeId: id });
    const cfg = get().activeConfig();
    if (cfg) broadcastPreview(cfg);
  },

  activeConfig: () => {
    const { selectedThemeId, drafts, loaded } = get();
    return drafts[selectedThemeId] ?? loaded[selectedThemeId] ?? null;
  },

  updateSection: (section, patch) => {
    const { selectedThemeId } = get();
    const base = get().activeConfig();
    if (!base) return;
    snapshotThrottled();
    const next: ThemeConfig = { ...base, [section]: { ...base[section], ...patch } };
    set((s) => ({ drafts: { ...s.drafts, [selectedThemeId]: next } }));
    useProjectStore.getState().markDirty();
    broadcastPreview(next);
  },

  resetSection: (section) => {
    const { selectedThemeId } = get();
    const base = get().activeConfig();
    if (!base) return;
    useProjectStore.getState().pushSnapshot();
    const defaults = defaultTheme();
    const next: ThemeConfig = { ...base, [section]: defaults[section] };
    set((s) => ({ drafts: { ...s.drafts, [selectedThemeId]: next } }));
    useProjectStore.getState().markDirty();
    broadcastPreview(next);
  },

  createTheme: async (name, sourceId) => {
    const env = await apiJson<ThemeEnvelope>('/api/themes', {
      method: 'POST',
      body: sourceId ? { name, source: sourceId } : { name },
    });
    await get().load();
    // select() previews the newly-created theme; load() already refreshed the
    // runtime cache, so no extra fetch and no snap back to the default theme.
    get().select(env.id);
  },

  deleteTheme: async (id) => {
    try {
      await apiJson(`/api/themes/${id}`, { method: 'DELETE' });
    } catch (err) {
      set({ loadError: err instanceof Error ? err.message : 'Failed to delete theme' });
      return;
    }
    set((s) => {
      const drafts = { ...s.drafts };
      delete drafts[id];
      return { drafts };
    });
    if (get().selectedThemeId === id) set({ selectedThemeId: '' });
    await get().load();
    const cfg = get().activeConfig();
    if (cfg) broadcastPreview(cfg);
  },

  setDefaultTheme: async (id) => {
    await apiJson('/api/default-theme', { method: 'PUT', body: { default: id } });
    set({ defaultThemeId: id });
    // The edited/previewed theme is unchanged; only the default pointer moves.
    // Sync the runtime cache's default id without re-applying tokens.
    setLoadedThemes(getLoadedThemes(), id);
  },
}));

// Register persistent save callback — runs at module load, never unregistered,
// so it fires on global Save regardless of which config page is active. Persists
// every dirty theme draft, then re-applies and pokes cross-tab sync.
useProjectStore.getState().registerSave('theme', async () => {
  const { drafts, selectedThemeId } = useThemeViewStore.getState();
  const ids = Object.keys(drafts);
  if (ids.length === 0) return;

  const savedEntries = await Promise.all(
    ids.map(
      async (id) =>
        [
          id,
          await apiJson<ThemeConfig>(`/api/themes/${id}`, { method: 'PUT', body: drafts[id] }),
        ] as const,
    ),
  );
  useThemeViewStore.setState((s) => ({
    loaded: { ...s.loaded, ...Object.fromEntries(savedEntries) },
    drafts: {},
  }));

  // Sync the runtime cache from the just-saved configs and re-apply the theme
  // being edited (not the default) so the live preview keeps showing it.
  const { loaded, defaultThemeId } = useThemeViewStore.getState();
  setLoadedThemes(loaded, defaultThemeId);
  const active = loaded[selectedThemeId];
  if (active) applyThemeTokens(active);
  try {
    localStorage.setItem(LS_THEME_SAVED, String(Date.now()));
  } catch {
    // Ignore storage write failures; save still succeeded.
  }
});

// Register undo/redo participation — runs at module load. Theme drafts ride
// along in the shared project history so the global Undo/Redo (and Ctrl+Z)
// revert theme edits like any other page; restoring re-applies the live preview.
useProjectStore.getState().registerSnapshotExtension('theme', {
  capture: () => structuredClone(useThemeViewStore.getState().drafts),
  restore: (data) => {
    useThemeViewStore.setState({ drafts: structuredClone(data as Record<string, ThemeConfig>) });
    const cfg = useThemeViewStore.getState().activeConfig();
    if (cfg) broadcastPreview(cfg);
  },
});
