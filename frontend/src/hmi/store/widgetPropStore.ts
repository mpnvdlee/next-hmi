import { create } from 'zustand';

/**
 * Runtime store for live component-exported property values.
 *
 * Components that declare exportedProperties in the registry
 * write their current values here via usePublishWidgetProp.
 * The $widgetProp expression evaluator reads from here.
 *
 * Keys: componentId → { propertyKey → value }
 */

interface ComponentPropStore {
  props: Record<string, Record<string, unknown>>;
  setComponentProp: (componentId: string, key: string, value: unknown) => void;
  clearComponentProps: (componentId: string) => void;
}

/**
 * Deep value equality for published prop values (primitives, arrays, plain
 * objects). Guards `setComponentProp` so republishing a freshly-built but
 * equal value is a no-op: many components derive their exported props each
 * render (e.g. a selected row rebuilt from a property source), so without this a
 * new reference would churn `props` on every render. Since `useEvalContext`
 * subscribes to `props`, that would re-render every `$widgetProp` reader — and
 * the publisher itself — on a loop.
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    const bArr = b as unknown[];
    if ((a as unknown[]).length !== bArr.length) return false;
    return (a as unknown[]).every((x, i) => valuesEqual(x, bArr[i]));
  }
  const aKeys = Object.keys(a as object);
  const bObj = b as Record<string, unknown>;
  if (aKeys.length !== Object.keys(bObj).length) return false;
  return aKeys.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(bObj, k) &&
      valuesEqual((a as Record<string, unknown>)[k], bObj[k]),
  );
}

export const useComponentPropStore = create<ComponentPropStore>((set) => ({
  props: {},

  setComponentProp: (componentId, key, value) =>
    set((state) => {
      const existing = state.props[componentId];
      if (existing && key in existing && valuesEqual(existing[key], value)) {
        return state; // unchanged value — keep `props` reference stable
      }
      return {
        props: {
          ...state.props,
          [componentId]: {
            ...existing,
            [key]: value,
          },
        },
      };
    }),

  clearComponentProps: (componentId) =>
    set((state) => {
      const { [componentId]: _removed, ...rest } = state.props;
      return { props: rest };
    }),
}));
