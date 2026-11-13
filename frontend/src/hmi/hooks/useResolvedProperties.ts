import { useMemo, useSyncExternalStore } from 'react';
import { useTranslationStore } from '@shared/store/translationStore';
import { isLocSource } from '@shared/types/propertyValueGuards';
import { useInputScope } from '../context/InputScopeContext';
import { resolveComponentPropValue } from '../utils/componentPropResolution';
import { useRepeatScope } from '../context/RepeatScopeContext';
import { useVariableStore } from '../store/variableStore';
import {
  containsRepeatRef,
  memberLeafKey,
  structElementPath,
  substituteRepeatRefs,
} from '../utils/repeatItemResolution';
import {
  collectBoundIndexes,
  substituteBoundIndexes,
  substituteMemberLeaves,
} from '../utils/boundIndexResolution';
import { analyzePropertyValue } from '../utils/analyzePropertyValue';
import { extractVarKeys } from '../utils/extractVarKeys';
import { resolveBoundIndex, type EvaluationContext } from '../utils/propertySourceEval';
import { noSubscribe, useLiveScalars } from './useLiveScalars';

/**
 * A widget's properties as its scope gives them: each `$loc` translated, each
 * `$componentProp` and `$repeatItem` swapped for what it names.
 */
export function useScopedProperties(
  properties: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const activeLanguage = useTranslationStore((s) => s.activeLanguage);
  const translations = useTranslationStore((s) => s.translations);
  const resolve = useTranslationStore((s) => s.resolve);
  const inputScope = useInputScope();
  const repeatScope = useRepeatScope();
  const repeats = repeatScope !== null && containsRepeatRef(properties);
  // A struct-array copy reads one thing off the metadata: its element's folder
  // name. Selecting the name rather than the map keeps a metadata frame that
  // leaves it alone from re-rendering every copy.
  const elementPath = useVariableStore((s) =>
    repeats && repeatScope.structArray && repeatScope.arrayKey
      ? structElementPath(s.varMeta, repeatScope.arrayKey, repeatScope.index)
      : undefined,
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

  return useMemo(
    () =>
      repeats && scoped
        ? (substituteRepeatRefs(scoped, repeatScope, useVariableStore.getState().varMeta) as Record<
            string,
            unknown
          >)
        : scoped,
    // `elementPath` is all of the metadata the substitution reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scoped, repeats, repeatScope, elementPath],
  );
}

/**
 * Each bound `$var.index` (a dialog's `$componentProp`, a `$var`) in
 * `properties` — a widget's properties or layout — as the number it resolves
 * to now, and then each member of a struct-array element as its own leaf
 * (`useMemberLeaves`). A `$var` inside an index is subscribed here, and the
 * resolved numbers key the memo: a moved index re-substitutes, so the widget
 * follows the new element; an unchanged one keeps the same object. `evalCtx`
 * must follow the stores the indexes read.
 */
export function useBoundIndexes<T extends object>(
  properties: T | undefined,
  evalCtx: EvaluationContext,
): T | undefined {
  const boundIndexes = useMemo(() => collectBoundIndexes(properties), [properties]);
  useLiveScalars(extractVarKeys(boundIndexes));
  const resolvedIndexes = boundIndexes.map((i) => resolveBoundIndex(i, evalCtx)).join(',');
  const indexed = useMemo(
    () =>
      resolvedIndexes
        ? (substituteBoundIndexes(properties, (i) => resolveBoundIndex(i, evalCtx)) as T)
        : properties,
    // evalCtx is read through `resolvedIndexes`, which changes whenever it matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [properties, resolvedIndexes],
  );
  return useMemberLeaves(indexed);
}

/** The member leaves `substituteMemberLeaves` binds for these indexed refs,
 *  as one string ('' for none): a snapshot equal by value while they stay. */
function memberLeaves(
  varMeta: Record<string, unknown>,
  refs: readonly { key: string; index: number }[],
): string {
  let leaves = '';
  for (const { key, index } of refs) {
    const leaf = memberLeafKey(varMeta, key, index);
    if (leaf !== undefined) leaves += `${leaf}\n`;
  }
  return leaves;
}

/**
 * `value` with each member of one struct-array element named through the
 * array — what `device/sName` makes of an input passing `PLC:Motors` at 1 —
 * bound to that member's own leaf (`substituteMemberLeaves`), once the
 * metadata names the element. Only a value with an indexed `$var` follows the
 * metadata, and only a change in the leaves it names re-renders it.
 */
function useMemberLeaves<T>(value: T): T {
  const refs = analyzePropertyValue(value).indexedVarRefs;
  const read = () => (refs.length ? memberLeaves(useVariableStore.getState().varMeta, refs) : '');
  const leaves = useSyncExternalStore(
    refs.length ? useVariableStore.subscribe : noSubscribe,
    read,
    read,
  );
  return useMemo(
    () =>
      leaves ? (substituteMemberLeaves(value, useVariableStore.getState().varMeta) as T) : value,
    [value, leaves],
  );
}
