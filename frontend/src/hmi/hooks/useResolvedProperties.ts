import { useMemo } from 'react';
import { useTranslationStore } from '@shared/store/translationStore';
import { isLocSource } from '@shared/types/propertyValueGuards';
import { useInputScope } from '../context/InputScopeContext';
import { resolveComponentPropValue } from '../utils/componentPropResolution';

export function useResolvedProperties(
  properties: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const activeLanguage = useTranslationStore((s) => s.activeLanguage);
  const translations = useTranslationStore((s) => s.translations);
  const resolve = useTranslationStore((s) => s.resolve);
  const inputScope = useInputScope();

  return useMemo(() => {
    if (!properties) return properties;
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(properties)) {
      if (isLocSource(v)) {
        out[k] = resolve(v.$loc);
        changed = true;
        continue;
      }
      const resolved = resolveComponentPropValue(v, inputScope?.properties);
      if (resolved !== v) {
        out[k] = resolved;
        changed = true;
      } else {
        out[k] = v;
      }
    }
    return changed ? out : properties;
    // activeLanguage and translations aren't read directly — resolve() reads
    // them via the store — but they must invalidate the memo so $loc values
    // re-resolve when the user changes language or edits a translation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [properties, resolve, activeLanguage, translations, inputScope]);
}
