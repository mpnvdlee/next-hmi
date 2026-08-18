import { useEvalContext } from './useEvalContext';
import { useLiveScalars } from './useLiveScalars';
import { useTimeTick } from './useTimeTick';
import { useHttpTick } from './useHttpTick';
import { analyzePropertyValue } from '../utils/analyzePropertyValue';
import type { EvaluationContext } from '../utils/propertySourceEval';

/**
 * Reactive `useEvalContext` for components rendered OUTSIDE the WidgetRenderer
 * tree — shell regions, dialogs, popups, the fallback NavigationMenu.
 *
 * `useEvalContext` is deliberately stable across variable/time ticks (widgets
 * get their reactivity from WidgetRenderer's granular subscriptions), so a
 * standalone consumer that evaluates `$var` / `$time` / `$http` at render with a
 * bare `useEvalContext` would render once and then freeze. This hook returns the
 * same eval context AND subscribes the caller to every `$var` key, the `$time`
 * tick and the `$http` response cache its expressions reference, so those values
 * keep updating.
 *
 * Pass every value that may carry expressions (properties, layout, config
 * fragments); one shared walk collects the keys and time usage.
 */
export function useReactiveEval(...values: unknown[]): EvaluationContext {
  const evalCtx = useEvalContext();

  const keys: string[] = [];
  let time = false;
  let http = false;
  for (const value of values) {
    const analysis = analyzePropertyValue(value);
    if (analysis.varKeys.length) keys.push(...analysis.varKeys);
    time = time || analysis.usesTime;
    http = http || analysis.usesHttp;
  }

  useLiveScalars(keys);
  useTimeTick(time);
  useHttpTick(http);
  return evalCtx;
}
