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
      datasource: 'PLC',
      path: 'Motor1/Run',
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
    executeWidgetActions([{ type: 'toggleDataVariable', datasource: '', path: '' }], {});
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
          datasource: 'Brew',
          path: 'Wizard/CupCount',
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
      [{ type: 'writeDataVariable', datasource: 'PLC', path: 'Arr', value: [1, 2] }],
      { scope: 'runtime' },
    );
    expect(sendWsMessage).toHaveBeenCalledWith(expect.objectContaining({ value: [1, 2] }));
  });
});

describe('if action', () => {
  const write = (path: string): ButtonAction => ({
    type: 'writeDataVariable',
    datasource: 'PLC',
    path,
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
});
