/**
 * ThemesView — /config/theme
 *
 * Multi-theme editor. A left ThemeTree selects which theme to edit; the main
 * panel shows that theme's token editor (Colors / Typography / Spacing). Edits
 * live-preview via CSS vars and are persisted on the global Save (drafts are
 * held per theme in themeViewStore). Tree actions add / duplicate / delete and
 * set the default theme.
 */

import { useEffect, useRef, useState } from 'react';
import ConfigLayout from '../components/ui/ConfigLayout';
import ConfigPageMessage from '../components/ui/ConfigPageMessage';
import ScrollPage from '../components/ui/ScrollPage';
import ThemeTree from '../components/themes/ThemeTree';
import ThemeEditor from '../components/themes/ThemeEditor';
import { useThemeViewStore } from '../store/themeViewStore';
import type { ThemeConfig, ThemeValidationResult } from '@shared/types/theme';
import type { ThemeSection } from '@shared/utils/themeTokens';
import { apiJson } from '@shared/utils/api';
import ConfigWorkspace from '../components/ui/ConfigWorkspace';

export default function ThemesView() {
  const loading = useThemeViewStore((s) => s.loading);
  const loadError = useThemeViewStore((s) => s.loadError);
  const selectedThemeId = useThemeViewStore((s) => s.selectedThemeId);
  const drafts = useThemeViewStore((s) => s.drafts);
  const loaded = useThemeViewStore((s) => s.loaded);
  const load = useThemeViewStore((s) => s.load);
  const updateSection = useThemeViewStore((s) => s.updateSection);
  const resetSection = useThemeViewStore((s) => s.resetSection);

  const theme: ThemeConfig | null = drafts[selectedThemeId] ?? loaded[selectedThemeId] ?? null;

  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  // Debounced server-side validation of the active theme.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!theme || !selectedThemeId) {
      setError(null);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    let cancelled = false;
    debounceRef.current = setTimeout(() => {
      void (async () => {
        try {
          const validation = await apiJson<ThemeValidationResult>(
            `/api/themes/${selectedThemeId}/validate`,
            { method: 'POST', body: theme },
          );
          if (cancelled) return;
          setError(
            validation.errors?.length ? validation.errors.map((e) => e.message).join(', ') : null,
          );
        } catch (err) {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : 'Validation failed');
        }
      })();
    }, 400);
    return () => {
      cancelled = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [theme, selectedThemeId]);

  if (loadError) {
    return <ConfigWorkspace title="Themes" loadError={loadError} />;
  }

  if (loading) {
    return <ConfigWorkspace title="Themes" loading />;
  }

  function handleChangeField(themePath: string, value: unknown) {
    const [section, field] = themePath.split('.');
    if (!section || !field) return;
    updateSection(section as ThemeSection, { [field]: value });
  }

  return (
    <ConfigLayout
      storageKey="themes"
      left={<ThemeTree />}
      center={
        <ConfigWorkspace title="Themes" flush>
          <ScrollPage>
            {theme ? (
              <ThemeEditor
                theme={theme}
                error={error}
                onChangeField={handleChangeField}
                onResetSection={(section) => resetSection(section)}
              />
            ) : (
              <ConfigPageMessage>Select a theme to edit.</ConfigPageMessage>
            )}
          </ScrollPage>
        </ConfigWorkspace>
      }
    />
  );
}
