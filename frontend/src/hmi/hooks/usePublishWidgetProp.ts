import { useEffect } from 'react';
import { useComponentPropStore } from '../store/widgetPropStore';

/**
 * Publishes a live component property value to widgetPropStore so that
 * sibling components can read it via the $widgetProp property source.
 *
 * Call once per exported property inside the component:
 *   usePublishWidgetProp(id, 'selectedValue', selectedValue);
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

  useEffect(() => {
    if (!componentId) return;
    setComponentProp(componentId, key, value);
  }, [componentId, key, value, setComponentProp]);

  useEffect(() => {
    if (!componentId) return;
    return () => {
      clearComponentProps(componentId);
    };
    // Only run cleanup on unmount (componentId stable per component instance)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [componentId]);
}
