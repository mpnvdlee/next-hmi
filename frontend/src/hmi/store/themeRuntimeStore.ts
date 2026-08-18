import { create } from 'zustand';

import {
  applyThemeById,
  getActiveThemeId,
  getLoadedThemes,
  loadAndApplyThemeTokens,
} from '@shared/utils/themeTokens';

/**
 * Ephemeral runtime theme selection. Session-only: the operator can switch the
 * active theme at runtime (e.g. day/night), but the choice is NOT persisted —
 * a reload returns to the project's default theme. Switching just re-applies a
 * cached ThemeConfig's `--hmi-*` tokens, which re-skins everything token-driven.
 */
interface ThemeRuntimeStore {
  activeThemeId: string;
  setActiveTheme: (id: string) => void;
  /**
   * Resync to whatever theme is actually applied. Used after a cross-tab save,
   * which may have deleted the theme the operator had switched to — in that
   * case the token applier falls back to the default and this realigns the id.
   */
  syncActiveTheme: () => void;
}

export const useThemeRuntimeStore = create<ThemeRuntimeStore>((set) => ({
  activeThemeId: getActiveThemeId(),

  setActiveTheme: (id: string) => {
    if (applyThemeById(id)) {
      set({ activeThemeId: id });
      return;
    }
    // Themes not loaded yet — fetch, then apply once available.
    void loadAndApplyThemeTokens().then(() => {
      if (getLoadedThemes()[id] && applyThemeById(id)) {
        set({ activeThemeId: id });
      }
    });
  },

  syncActiveTheme: () => set({ activeThemeId: getActiveThemeId() }),
}));
