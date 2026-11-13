import { useMemo } from 'react';
import { storesReadBy, useEvalContext } from './useEvalContext';
import { useLiveKeys, useLiveScalars } from './useLiveScalars';
import { useTimeTick } from './useTimeTick';
import { useHttpTick } from './useHttpTick';
import { analyzePropertyValue } from '../utils/analyzePropertyValue';
import type { EvaluationContext } from '../utils/propertySourceEval';

/**
 * Reactive `useEvalContext` for components rendered OUTSIDE the WidgetRenderer
 * tree — shell regions and popups.
 *
 * `useEvalContext` is deliberately stable across variable/time ticks (widgets
 * get their reactivity from WidgetRenderer's granular subscriptions), so a
 * standalone consumer that evaluates `$var` / `$time` / `$http` at render with a
 * bare `useEvalContext` would render once and then freeze. This hook returns the
 * same eval context AND subscribes the caller to the keys its expressions read
 * (`useLiveKeys`, as a widget does), the `$time` tick, the `$http` response
 * cache and the stores its expressions reference, so those values keep updating.
 *
 * Pass every value that may carry expressions (properties, layout, config
 * fragments); one shared walk collects the keys and time usage.
 */
export function useReactiveEval(...values: unknown[]): EvaluationContext {
  // One value for the walks below, the same while every part is: each walk is
  // then cached rather than redone on every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const all = useMemo(() => values, values);
  // Named, not the surrounding widget's: a popup a widget opens (an alarm
  // list's detail dialog) renders inside it.
  const evalCtx = useEvalContext(storesReadBy(all));
  const { usesTime, usesHttp } = analyzePropertyValue(all);
  useLiveScalars(useLiveKeys(all));
  useTimeTick(usesTime);
  useHttpTick(usesHttp);
  return evalCtx;
}
