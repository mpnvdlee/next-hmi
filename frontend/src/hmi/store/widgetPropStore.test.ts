import { describe, it, expect, beforeEach } from 'vitest';
import { useComponentPropStore } from './widgetPropStore';

describe('widgetPropStore.setComponentProp', () => {
  beforeEach(() => {
    useComponentPropStore.setState({ props: {} });
  });

  it('publishes a new value', () => {
    const { setComponentProp } = useComponentPropStore.getState();
    setComponentProp('grid', 'selectedRow', { id: 'a', name: 'A' });
    expect(useComponentPropStore.getState().props.grid.selectedRow).toEqual({ id: 'a', name: 'A' });
  });

  it('keeps the props reference stable when republishing a deep-equal value', () => {
    const { setComponentProp } = useComponentPropStore.getState();
    setComponentProp('grid', 'selectedRow', { id: 'a', name: 'A' });
    const before = useComponentPropStore.getState().props;

    // A freshly-built but equal object (as a property source rebuilds each render)
    // must not churn `props` — otherwise $widgetProp readers loop-render.
    setComponentProp('grid', 'selectedRow', { id: 'a', name: 'A' });
    expect(useComponentPropStore.getState().props).toBe(before);
  });

  it('updates when the value actually changes', () => {
    const { setComponentProp } = useComponentPropStore.getState();
    setComponentProp('grid', 'selectedRow', { id: 'a' });
    const before = useComponentPropStore.getState().props;
    setComponentProp('grid', 'selectedRow', { id: 'b' });
    expect(useComponentPropStore.getState().props).not.toBe(before);
    expect(useComponentPropStore.getState().props.grid.selectedRow).toEqual({ id: 'b' });
  });

  it('treats republished undefined as unchanged', () => {
    const { setComponentProp } = useComponentPropStore.getState();
    setComponentProp('grid', 'selectedRow', undefined);
    const before = useComponentPropStore.getState().props;
    setComponentProp('grid', 'selectedRow', undefined);
    expect(useComponentPropStore.getState().props).toBe(before);
  });
});
