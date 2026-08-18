import { useMemo } from 'react';
import { useTranslationStore } from '@shared/store/translationStore';

/**
 * The active interface language and the setter that changes it.
 *
 * `useLanguagesData` supplies the list to choose from; this is the other half,
 * so a project can ship its own language picker. Setting the language re-runs
 * every `$loc` source in the app.
 */
export function useLanguageSelection(): {
  activeLanguage: string;
  setActiveLanguage: (code: string) => void;
} {
  const activeLanguage = useTranslationStore((s) => s.activeLanguage);
  const setActiveLanguage = useTranslationStore((s) => s.setActiveLanguage);
  return useMemo(
    () => ({ activeLanguage, setActiveLanguage }),
    [activeLanguage, setActiveLanguage],
  );
}
