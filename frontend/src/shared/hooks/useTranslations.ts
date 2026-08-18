import { useEffect } from 'react';
import { useTranslationStore } from '../store/translationStore';

/**
 * Fetches translations from the backend on mount and stores them in translationStore.
 * The store itself decides whether to skip loading when unsaved edits exist.
 * Call once at the top of any view that needs translation data.
 */
export function useTranslations(): void {
  const load = useTranslationStore((s) => s.loadTranslations);

  useEffect(() => {
    void load();
  }, [load]);
}
