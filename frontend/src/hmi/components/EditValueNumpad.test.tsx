import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ButtonAction } from '@shared/types/config';

const { sendWsMessage } = vi.hoisted(() => ({ sendWsMessage: vi.fn() }));
vi.mock('@hmi/hooks/useWebSocket', () => ({ sendWsMessage }));

import { EditValueNumpad } from './EditValueNumpad';
import { executeWidgetActions } from '@hmi/utils/widgetActions';
import { registerActionRunner, resolvePending, __resetForTests } from '@hmi/utils/actionDispatcher';
import { useHmiStore } from '@hmi/store/hmiStore';
import { useVariableStore } from '@hmi/store/variableStore';

const edit = (extra: Partial<Extract<ButtonAction, { type: 'editValue' }>> = {}): ButtonAction => ({
  type: 'editValue',
  target: { $var: { path: 'PLC:Line/Speed' } },
  title: { $static: 'Speed' },
  ...extra,
});

// The icon keys carry no names; the digit keys are named by their text.
const ICON_KEYS: Record<string, string> = {
  Back: '.hmi-virtual-input__key--back',
  Clear: '.hmi-virtual-input__key--clear',
  Enter: '.hmi-virtual-input__key--accent',
  'Close numpad': '.hmi-virtual-input__close',
};
const keyFor = (key: string) =>
  key in ICON_KEYS
    ? document.querySelector<HTMLElement>(ICON_KEYS[key])!
    : screen.getByRole('button', { name: key });

function press(...keys: string[]) {
  for (const key of keys) fireEvent.click(keyFor(key));
}

beforeEach(() => {
  sendWsMessage.mockClear();
  __resetForTests();
  registerActionRunner(executeWidgetActions);
  useHmiStore.setState({ numpadRequest: null, pendingToasts: [] });
  useVariableStore.setState({
    values: { 'PLC:Line/Speed': 120 },
    varMeta: {
      'PLC:Line/Speed': {
        type: { kind: 'scalar', base: 'Integer', array: false },
        min: 80,
        max: 200,
      },
    },
  } as never);
});

describe('editValue', () => {
  it('opens on the current value and writes the entered one on Enter', () => {
    render(<EditValueNumpad />);
    act(() => executeWidgetActions([edit()], { scope: 'runtime' }));

    expect(screen.getByText('Current setpoint 120')).toBeTruthy();
    // An Integer variable takes no decimal point.
    expect(screen.getByRole('button', { name: '.' })).toHaveProperty('disabled', true);
    press('1', '5', '0', 'Enter');

    expect(sendWsMessage).toHaveBeenCalledWith({
      type: 'write_field',
      scope: 'runtime',
      datasource: 'PLC',
      path: 'Line/Speed',
      value: 150,
    });
    expect(useHmiStore.getState().numpadRequest).toBeNull();
  });

  it("refuses a value outside the variable's range unless the action sets its own", () => {
    render(<EditValueNumpad />);
    act(() => executeWidgetActions([edit()], { scope: 'runtime' }));
    press('5', '0');
    expect(screen.getByRole('alert').textContent).toBe('Enter a value between 80 and 200');

    act(() => executeWidgetActions([edit({ min: 0 })], { scope: 'runtime' }));
    press('5', '0', 'Enter');
    expect(sendWsMessage).toHaveBeenCalledWith(expect.objectContaining({ value: 50 }));
  });

  it('writes nothing and runs no handler on cancel', () => {
    render(<EditValueNumpad />);
    const onSettled: ButtonAction[] = [
      { type: 'showToast', message: 'x', severity: 'info', discard: 'auto' },
    ];
    act(() => executeWidgetActions([edit({ onSettled })], { scope: 'runtime' }));
    press('9');
    fireEvent.click(document.querySelector<HTMLElement>('.hmi-virtual-input__close')!);

    expect(sendWsMessage).not.toHaveBeenCalled();
    expect(useHmiStore.getState().pendingToasts).toEqual([]);
  });

  it('hands the handlers the entered and the previous value as $result', () => {
    render(<EditValueNumpad />);
    const onSuccess: ButtonAction[] = [
      {
        type: 'showToast',
        message: {
          $stringExpr: {
            template: '{1} → {2}',
            wildcards: { 1: { $result: 'previous' }, 2: { $result: 'value' } },
          },
        },
        severity: 'success',
        discard: 'auto',
      },
    ];
    act(() => executeWidgetActions([edit({ onSuccess })], { scope: 'runtime' }));
    press('9', '0', 'Enter');

    const { requestId } = sendWsMessage.mock.calls[0][0] as { requestId: string };
    act(() => resolvePending(requestId, { datasource: 'PLC', path: 'Line/Speed' }, true));
    expect(useHmiStore.getState().pendingToasts[0]?.message).toBe('120 → 90');
  });
});
