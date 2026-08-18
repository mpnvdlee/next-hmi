import { useTranslationStore } from '@shared/store/translationStore';
import type { Language } from '@shared/store/translationStore';

/**
 * Subscribe to the configured language list from the translation store.
 * Returns an empty array until translations are loaded.
 */
export function useLanguagesData(): Language[] {
  return useTranslationStore((s) => s.languages);
}
