import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ButtonAction } from '@shared/types/config';

const { sendWsMessage, beginAsyncAction } = vi.hoisted(() => ({
  sendWsMessage: vi.fn(),
  beginAsyncAction: vi.fn(() => 'req-1'),
}));

vi.mock('@hmi/hooks/useWebSocket', () => ({ sendWsMessage }));
vi.mock('@hmi/utils/actionDispatcher', () => ({ beginAsyncAction }));

import { executeWidgetActions } from './widgetActions';

beforeEach(() => {
  sendWsMessage.mockClear();
  beginAsyncAction.mockClear();
});

describe('toggleDataVariable dispatch', () => {
  it('sends toggle_field with no value — the server reads the current one', () => {
    const action: ButtonAction = {
      type: 'toggleDataVariable',
      target: { $var: { path: 'PLC:Motor1/Run' } },
      onFailed: [],
    };
    executeWidgetActions([action], { scope: 'runtime' });

    expect(beginAsyncAction).toHaveBeenCalledWith(action, 'runtime', undefined);
    expect(sendWsMessage).toHaveBeenCalledWith({
      type: 'toggle_field',
      requestId: 'req-1',
      scope: 'runtime',
      datasource: 'PLC',
      path: 'Motor1/Run',
    });
  });

  it('skips dispatch when no variable is bound', () => {
    executeWidgetActions([{ type: 'toggleDataVariable' }], {});
    expect(sendWsMessage).not.toHaveBeenCalled();
    expect(beginAsyncAction).not.toHaveBeenCalled();
  });
});

describe('writeDataVariable value resolution', () => {
  it('resolves a $componentProp value against the firing scope before sending', () => {
    executeWidgetActions(
      [
        {
          type: 'writeDataVariable',
          target: { $var: { path: 'Brew:Wizard/CupCount' } },
          value: { $componentProp: 'startingCupCount' },
        },
      ],
      { scope: 'runtime', evalCtx: { inputScopeProps: { startingCupCount: 4 } } },
    );
    expect(sendWsMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'write_field', value: 4 }),
    );
  });

  it('sends a literal array untouched', () => {
    executeWidgetActions(
      [{ type: 'writeDataVariable', target: { $var: { path: 'PLC:Arr' } }, value: [1, 2] }],
      { scope: 'runtime' },
    );
    expect(sendWsMessage).toHaveBeenCalledWith(expect.objectContaining({ value: [1, 2] }));
  });
});

describe('a write target with a bound index', () => {
  const target = { $var: { path: 'CF:Safety/Open', index: { $componentProp: 'device' } } };

  it('toggles the element the dialog input names', () => {
    executeWidgetActions([{ type: 'toggleDataVariable', target } as ButtonAction], {
      scope: 'runtime',
      evalCtx: { inputScopeProps: { device: 4 } },
    });
    expect(sendWsMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'toggle_field', path: 'Safety/Open[4]' }),
    );
  });

  it('sends an index the server refuses as out of bounds when the input is missing', () => {
    executeWidgetActions([{ type: 'writeDataVariable', target, value: true } as ButtonAction], {
      scope: 'runtime',
      evalCtx: { inputScopeProps: {} },
    });
    expect(sendWsMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'write_field', path: 'Safety/Open[-1]' }),
    );
  });
});

describe('if action', () => {
  const write = (path: string): ButtonAction => ({
    type: 'writeDataVariable',
    target: { $var: { path: `PLC:${path}` } },
    value: 1,
  });

  it('runs the then branch when the condition holds', () => {
    executeWidgetActions(
      [
        {
          type: 'if',
          condition: { $componentProp: 'on' },
          then: [write('Yes')],
          else: [write('No')],
        },
      ],
      { evalCtx: { inputScopeProps: { on: true } } },
    );
    expect(sendWsMessage).toHaveBeenCalledTimes(1);
    expect(sendWsMessage).toHaveBeenCalledWith(expect.objectContaining({ path: 'Yes' }));
  });

  it('runs the else branch when it does not', () => {
    executeWidgetActions(
      [{ type: 'if', condition: false, then: [write('Yes')], else: [write('No')] }],
      {},
    );
    expect(sendWsMessage).toHaveBeenCalledWith(expect.objectContaining({ path: 'No' }));
  });

  it('reads a bound variable from the live store when the context has no reader', async () => {
    const { useVariableStore } = await import('@hmi/store/variableStore');
    useVariableStore.setState({ values: { 'PLC:Mode': 2 } } as never);
    executeWidgetActions(
      [
        {
          type: 'if',
          condition: {
            $compare: { left: { $var: { path: 'PLC:Mode' } }, operator: '===', right: 2 },
          },
          then: [write('Two')],
        },
      ],
      {},
    );
    expect(sendWsMessage).toHaveBeenCalledWith(expect.objectContaining({ path: 'Two' }));
  });

  it("checks the scope's signed-in user when the context has no user reader", async () => {
    const { useHmiStore } = await import('@hmi/store/hmiStore');
    useHmiStore.setState({
      currentUsersByScope: {
        'runtime:a': { username: 'mark', groups: ['admin'], groupLabels: {} },
      },
    });
    // A page's onOpen guard: the event hook passes no reader of its own.
    executeWidgetActions(
      [
        {
          type: 'if',
          condition: { $userGroups: { groups: ['admin'] } },
          then: [write('Admin')],
          else: [write('Other')],
        },
      ],
      { scope: 'runtime:a' },
    );
    expect(sendWsMessage).toHaveBeenCalledWith(expect.objectContaining({ path: 'Admin' }));
  });
});

describe('a $componentProp write target', () => {
  // Inside a component the instance passes the variable as an input; the
  // action's target names that input instead of a variable of its own.
  const ctx = {
    scope: 'runtime',
    evalCtx: { inputScopeProps: { value: { $var: { path: 'CP:Params/MaxPressure' } } } },
  };
  const target = { $componentProp: 'value' };

  it('writes the variable the instance passed in', () => {
    executeWidgetActions([{ type: 'writeDataVariable', target, value: 7 }], ctx);
    expect(sendWsMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'write_field',
        datasource: 'CP',
        path: 'Params/MaxPressure',
        value: 7,
      }),
    );
  });

  it('toggles the variable the instance passed in', () => {
    executeWidgetActions([{ type: 'toggleDataVariable', target }], ctx);
    expect(sendWsMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'toggle_field',
        datasource: 'CP',
        path: 'Params/MaxPressure',
      }),
    );
  });

  it('opens Edit Value on the variable the instance passed in', async () => {
    const { useHmiStore } = await import('@hmi/store/hmiStore');
    executeWidgetActions([{ type: 'editValue', target }], ctx);
    const numpad = useHmiStore.getState().numpadRequest;
    expect(numpad).not.toBeNull();
    numpad!.apply(12.5);
    expect(sendWsMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'write_field',
        datasource: 'CP',
        path: 'Params/MaxPressure',
        value: 12.5,
      }),
    );
  });

  it('writes nothing when the input is not a variable', () => {
    executeWidgetActions([{ type: 'writeDataVariable', target, value: 7 }], {
      scope: 'runtime',
      evalCtx: { inputScopeProps: { value: 3 } },
    });
    expect(sendWsMessage).not.toHaveBeenCalled();
  });
});
