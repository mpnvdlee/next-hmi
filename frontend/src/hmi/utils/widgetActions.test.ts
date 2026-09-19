import { beforeEach, describe, expect, it } from 'vitest';
import type { ButtonAction } from '@shared/types/config';
import { useHmiStore } from '@hmi/store/hmiStore';
import { executeWidgetActions } from './widgetActions';

function anchorElement(rect: Partial<DOMRect>): HTMLElement {
  const el = document.createElement('button');
  el.getBoundingClientRect = () =>
    ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, ...rect }) as DOMRect;
  return el;
}

describe('executeWidgetActions — anchored placement', () => {
  beforeEach(() => {
    useHmiStore.setState({ openPageOverlays: [] });
  });

  it('captures the trigger rect for an anchored page overlay', () => {
    const action: ButtonAction = {
      type: 'openPageOverlay',
      pageId: 'p1',
      placement: 'trigger-below',
      backdrop: 'none',
    };
    executeWidgetActions([action], {
      anchorEl: anchorElement({
        top: 10,
        left: 20,
        right: 120,
        bottom: 40,
        width: 100,
        height: 30,
      }),
    });

    const entry = useHmiStore.getState().openPageOverlays[0];
    expect(entry.anchorRect).toEqual({
      top: 10,
      left: 20,
      right: 120,
      bottom: 40,
      width: 100,
      height: 30,
    });
    expect(entry.backdrop).toBe('none');
  });

  it('ignores the trigger for viewport (non-anchored) placement', () => {
    const action: ButtonAction = { type: 'openPageOverlay', pageId: 'p1', placement: 'center' };
    executeWidgetActions([action], { anchorEl: anchorElement({ top: 10, left: 20 }) });

    expect(useHmiStore.getState().openPageOverlays[0].anchorRect).toBeUndefined();
  });

  it('leaves anchorRect unset when no trigger element is available', () => {
    const action: ButtonAction = {
      type: 'openPageOverlay',
      pageId: 'p1',
      placement: 'trigger-right',
    };
    executeWidgetActions([action], {});

    expect(useHmiStore.getState().openPageOverlays[0].anchorRect).toBeUndefined();
  });
});

describe('executeWidgetActions — openDialog component properties', () => {
  beforeEach(() => {
    useHmiStore.setState({ openPageOverlays: [] });
  });

  it('stores the values the action supplies', () => {
    const action: ButtonAction = {
      type: 'openDialog',
      pageId: 'p1',
      componentProperties: { motorId: 'M7', speed: { $var: { path: 'PLC:Speed' } } },
    };
    executeWidgetActions([action], {});

    expect(useHmiStore.getState().openPageOverlays[0].componentProperties).toEqual({
      motorId: 'M7',
      speed: { $var: { path: 'PLC:Speed' } },
    });
  });

  it('forwards the firing site’s own props through a $componentProp value', () => {
    // An overlay opened from inside a component passes its own input along.
    const action: ButtonAction = {
      type: 'openDialog',
      pageId: 'p1',
      componentProperties: { motorId: { $componentProp: 'machine' } },
    };
    executeWidgetActions([action], { evalCtx: { inputScopeProps: { machine: 'M9' } } });

    expect(useHmiStore.getState().openPageOverlays[0].componentProperties).toEqual({
      motorId: 'M9',
    });
  });

  it('defaults to an empty map when the action carries none', () => {
    executeWidgetActions([{ type: 'openDialog', pageId: 'p1' }], {});
    expect(useHmiStore.getState().openPageOverlays[0].componentProperties).toEqual({});
  });

  it('passes none for a page opened as an overlay, which declares none', () => {
    executeWidgetActions([{ type: 'openPageOverlay', pageId: 'p1' }], {});
    expect(useHmiStore.getState().openPageOverlays[0].componentProperties).toEqual({});
  });
});
