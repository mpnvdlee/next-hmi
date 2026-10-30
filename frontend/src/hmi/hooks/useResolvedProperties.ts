import { useMemo } from 'react';
import { useTranslationStore } from '@shared/store/translationStore';
import { isLocSource } from '@shared/types/propertyValueGuards';
import { useInputScope } from '../context/InputScopeContext';
import { resolveComponentPropValue } from '../utils/componentPropResolution';
import { useRepeatScope } from '../context/RepeatScopeContext';
import { useVariableStore } from '../store/variableStore';
import { containsRepeatRef, substituteRepeatRefs } from '../utils/repeatItemResolution';
import { collectBoundIndexes, substituteBoundIndexes } from '../utils/boundIndexResolution';
import { extractVarKeys } from '../utils/extractVarKeys';
import { resolveBoundIndex } from '../utils/propertySourceEval';
import { useEvalContext } from './useEvalContext';
import { useLiveScalars } from './useLiveScalars';

const NO_META: Record<string, unknown> = {};

export function useResolvedProperties(
  properties: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const activeLanguage = useTranslationStore((s) => s.activeLanguage);
  const translations = useTranslationStore((s) => s.translations);
  const resolve = useTranslationStore((s) => s.resolve);
  const inputScope = useInputScope();
  const repeatScope = useRepeatScope();
  const repeats = repeatScope !== null && containsRepeatRef(properties);
  // Only a struct-array copy needs the metadata (for its element's folder
  // name); the rest must not re-render when it arrives.
  const varMeta = useVariableStore((s) =>
    repeats && repeatScope.structArray ? s.varMeta : NO_META,
  );

  const scoped = useMemo(() => {
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

  const repeated = useMemo(
    () =>
      repeats && scoped
        ? (substituteRepeatRefs(scoped, repeatScope, varMeta) as Record<string, unknown>)
        : scoped,
    [scoped, repeats, repeatScope, varMeta],
  );

  // A bound `$var.index` (a dialog's `$componentProp`, a `$var`) becomes the
  // number it resolves to now. A `$var` inside an index is subscribed here, and
  // the resolved numbers key the memo: a moved index re-substitutes, so the
  // widget follows the new element; an unchanged one keeps the same object.
  const evalCtx = useEvalContext();
  const boundIndexes = useMemo(() => collectBoundIndexes(repeated), [repeated]);
  useLiveScalars(extractVarKeys(boundIndexes));
  const resolvedIndexes = boundIndexes.map((i) => resolveBoundIndex(i, evalCtx)).join(',');
  return useMemo(
    () =>
      resolvedIndexes
        ? (substituteBoundIndexes(repeated, (i) => resolveBoundIndex(i, evalCtx)) as Record<
            string,
            unknown
          >)
        : repeated,
    // evalCtx is read through `resolvedIndexes`, which changes whenever it matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repeated, resolvedIndexes],
  );
}
