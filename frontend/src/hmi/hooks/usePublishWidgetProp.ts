import { useEffect, useRef } from 'react';
import { useComponentPropStore } from '../store/widgetPropStore';
import { useRepeatScope } from '../context/RepeatScopeContext';

/** Store key for a widget's exports inside one Repeater copy. */
export function scopedWidgetId(componentId: string, repeatKey: string): string {
  return `${componentId}@${repeatKey}`;
}

function publishIds(componentId: string, scopedId: string | undefined, bare: boolean): string[] {
  const ids = scopedId ? [scopedId] : [];
  if (bare) ids.push(componentId);
  return ids;
}

/**
 * Publishes a live component property value to widgetPropStore so that
 * sibling components can read it via the $widgetProp property source.
 *
 * Call once per exported property inside the component:
 *   usePublishWidgetProp(id, 'selectedValue', selectedValue);
 *
 * Inside a Repeater every copy shares the template widget's id, so each copy
 * publishes under its own key as well; the first copy also publishes under the
 * bare id, which is what a reader outside the Repeater gets.
 *
 * Cleans up on unmount by removing this component's entry from the store.
 */
export function usePublishWidgetProp(
  componentId: string | undefined,
  key: string,
  value: unknown,
): void {
  const setComponentProp = useComponentPropStore((s) => s.setComponentProp);
  const clearComponentProps = useComponentPropStore((s) => s.clearComponentProps);
  const repeatScope = useRepeatScope();
  const scopedId =
    componentId && repeatScope ? scopedWidgetId(componentId, repeatScope.key) : undefined;
  const publishesBare = !repeatScope || repeatScope.first;
  // Read at unmount: a copy can become (or stop being) the first while mounted.
  const publishesBareRef = useRef(publishesBare);
  publishesBareRef.current = publishesBare;

  useEffect(() => {
    if (!componentId) return;
    setComponentProp(publishIds(componentId, scopedId, publishesBare), key, value);
  }, [componentId, scopedId, publishesBare, key, value, setComponentProp]);

  useEffect(() => {
    if (!componentId) return;
    return () => {
      clearComponentProps(publishIds(componentId, scopedId, publishesBareRef.current));
    };
    // Only run cleanup on unmount (ids stable per component instance)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [componentId, scopedId]);
}
