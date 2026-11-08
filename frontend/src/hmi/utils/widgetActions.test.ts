import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ButtonAction } from '@shared/types/config';
import { useHmiStore } from '@hmi/store/hmiStore';
import { useVariableStore } from '@hmi/store/variableStore';
import { useConfigStore } from '@shared/store/configStore';
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

  it('reads a Value input once, in the opener’s context, and passes a Binding as its variable', () => {
    useConfigStore.setState({
      dialogs: [
        {
          id: 'p1',
          title: 'Motor',
          type: 'page',
          sections: { content: [] },
          componentProperties: {
            jog: { type: 'float', label: 'Jog', mode: 'value' },
            speed: { type: 'float', label: 'Speed', mode: 'binding' },
          },
        },
      ],
    });
    useVariableStore.setState({ values: { 'PLC:Speed': 20 } });
    const speed = { $var: { path: 'PLC:Speed' } };
    const action: ButtonAction = {
      type: 'openDialog',
      pageId: 'p1',
      componentProperties: {
        jog: { $formula: { expression: '{1} * 0.5', wildcards: { '1': speed } } },
        speed,
      },
    };
    executeWidgetActions([action], {});

    expect(useHmiStore.getState().openPageOverlays[0].componentProperties).toEqual({
      jog: 10,
      speed,
    });
    useConfigStore.setState({ dialogs: [] });
  });

  it('reads a Value input an enclosing group declares in the opener’s context', () => {
    useConfigStore.setState({
      dialogs: [
        {
          id: 'g1',
          title: 'Devices',
          type: 'page-group',
          componentProperties: { zone: { type: 'string', label: 'Zone', mode: 'value' } },
          children: [{ id: 'p1', title: 'Motor', type: 'page', sections: { content: [] } }],
        } as never,
      ],
    });
    useVariableStore.setState({ values: { 'PLC:Zone': 'A' } });
    executeWidgetActions(
      [
        {
          type: 'openDialog',
          pageId: 'p1',
          componentProperties: { zone: { $var: { path: 'PLC:Zone' } } },
        },
      ],
      {},
    );

    expect(useHmiStore.getState().openPageOverlays[0].componentProperties).toEqual({ zone: 'A' });
    useConfigStore.setState({ dialogs: [] });
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
  it('swaps the inputs and anchor of the dialog on top when it is opened again', () => {
    const open = (device: number, left: number) =>
      executeWidgetActions(
        [
          {
            type: 'openDialog',
            pageId: 'device',
            componentProperties: { device },
            placement: 'trigger-below',
          },
        ],
        { anchorEl: anchorElement({ left, width: 20, height: 20 }) },
      );
    open(4, 10);
    open(5, 300);

    const overlays = useHmiStore.getState().openPageOverlays;
    expect(overlays).toHaveLength(1);
    expect(overlays[0].componentProperties).toEqual({ device: 5 });
    expect(overlays[0].anchorRect?.left).toBe(300);
  });

  it('leaves a dialog lower in the stack alone when it is opened again', () => {
    executeWidgetActions(
      [{ type: 'openDialog', pageId: 'device', componentProperties: { device: 4 } }],
      {},
    );
    executeWidgetActions([{ type: 'openDialog', pageId: 'confirm' }], {});
    executeWidgetActions(
      [{ type: 'openDialog', pageId: 'device', componentProperties: { device: 5 } }],
      {},
    );

    const overlays = useHmiStore.getState().openPageOverlays;
    expect(overlays.map((o) => o.pageId)).toEqual(['device', 'confirm']);
    expect(overlays[0].componentProperties).toEqual({ device: 4 });
  });
});

describe('executeWidgetActions — delay', () => {
  beforeEach(() => {
    useHmiStore.setState({ pendingToasts: [] });
  });

  it('runs the actions after a Delay once it has passed, reading values of that moment', () => {
    vi.useFakeTimers();
    try {
      executeWidgetActions([
        { type: 'showToast', message: 'Before' },
        { type: 'delay', duration: 500 },
        { type: 'showToast', message: 'After' },
      ] as ButtonAction[]);
      const messages = () => useHmiStore.getState().pendingToasts.map((t) => t.message);

      expect(messages()).toEqual(['Before']);
      vi.advanceTimersByTime(499);
      expect(messages()).toEqual(['Before']);
      vi.advanceTimersByTime(1);
      expect(messages()).toEqual(['Before', 'After']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('executeWidgetActions — runComponentActions', () => {
  beforeEach(() => {
    useHmiStore.setState({ openPageOverlays: [] });
  });

  it('runs the list the instance passes in through the named property', () => {
    executeWidgetActions([{ type: 'runComponentActions', property: 'actions' }], {
      evalCtx: {
        inputScopeProps: { actions: { onPress: [{ type: 'openPageOverlay', pageId: 'p1' }] } },
      },
    });

    expect(useHmiStore.getState().openPageOverlays.map((o) => o.pageId)).toEqual(['p1']);
  });

  it('does nothing when the instance sets no actions', () => {
    executeWidgetActions([{ type: 'runComponentActions', property: 'actions' }], {
      evalCtx: { inputScopeProps: {} },
    });

    expect(useHmiStore.getState().openPageOverlays).toEqual([]);
  });
});
