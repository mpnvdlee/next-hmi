/**
 * The acknowledgement half of `alarmUtils` — the SDK's `ackAlarm` /
 * `ackAllAlarms`.
 *
 * Both used to hand their rejection back to the caller, and every caller
 * awaited them bare: a refused ack became an unhandled promise rejection and
 * the operator saw nothing at all. They now carry `useWriteVariable`'s error
 * contract, which is what these tests pin.
 */
import { act, renderHook } from '@testing-library/react';
import type { AlarmInstance } from '@shared/types/alarm';
import { useAlarmStore } from '@hmi/store/alarmStore';
import { useHmiStore } from '@hmi/store/hmiStore';
import { useVariableStore } from '@hmi/store/variableStore';
import { apiJson } from '@shared/utils/api';
import { ackAlarm, ackAllAlarms, useAlarmText } from './alarmUtils';

vi.mock('@shared/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/utils/api')>()),
  apiJson: vi.fn(),
}));

function toasts() {
  return useHmiStore.getState().pendingToasts;
}

describe('ackAlarm', () => {
  beforeEach(() => {
    vi.mocked(apiJson).mockReset();
    useHmiStore.setState({ pendingToasts: [] });
  });

  it('posts the acknowledgement and resolves true without toasting', async () => {
    vi.mocked(apiJson).mockResolvedValue(undefined);

    await expect(ackAlarm('inst-1', 'operator')).resolves.toBe(true);

    expect(apiJson).toHaveBeenCalledWith('/api/alarms/ack/inst-1', {
      method: 'POST',
      body: { username: 'operator' },
    });
    expect(toasts()).toHaveLength(0);
  });

  it('resolves false and toasts the reason when the backend refuses', async () => {
    vi.mocked(apiJson).mockRejectedValue(new Error('You are not allowed to acknowledge'));

    await expect(ackAlarm('inst-1', 'operator')).resolves.toBe(false);

    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].severity).toBe('error');
    expect(toasts()[0].message).toMatch(/not allowed to acknowledge/);
  });

  it('reuses one toast per instance, and gives a second instance its own', async () => {
    vi.mocked(apiJson).mockRejectedValue(new Error('Server unavailable'));

    await ackAlarm('inst-1', 'operator');
    await ackAlarm('inst-1', 'operator');
    expect(toasts()).toHaveLength(1);

    await ackAlarm('inst-2', 'operator');
    expect(toasts()).toHaveLength(2);
  });

  it('honours onError: silent and the callback form', async () => {
    vi.mocked(apiJson).mockRejectedValue(new Error('Alarm not found'));

    await expect(ackAlarm('inst-1', 'operator', { onError: 'silent' })).resolves.toBe(false);
    expect(toasts()).toHaveLength(0);

    const reasons: string[] = [];
    await ackAlarm('inst-1', 'operator', { onError: (reason) => reasons.push(reason) });
    expect(reasons).toEqual(['Alarm not found']);
    expect(toasts()).toHaveLength(0);
  });
});

describe('ackAllAlarms', () => {
  beforeEach(() => {
    vi.mocked(apiJson).mockReset();
    useHmiStore.setState({ pendingToasts: [] });
  });

  it('posts the acknowledgement and resolves true', async () => {
    vi.mocked(apiJson).mockResolvedValue(undefined);

    await expect(ackAllAlarms('operator')).resolves.toBe(true);

    expect(apiJson).toHaveBeenCalledWith('/api/alarms/ack-all', {
      method: 'POST',
      body: { username: 'operator' },
    });
  });

  it('resolves false and toasts once however often it is refused', async () => {
    vi.mocked(apiJson).mockRejectedValue(new Error('Server unreachable'));

    await expect(ackAllAlarms('operator')).resolves.toBe(false);
    await ackAllAlarms('operator');

    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].message).toMatch(/Server unreachable/);
  });
});

describe('useAlarmText placeholders', () => {
  const TEXT = 'Temp {Round1(1)} at {2}';
  const active = {
    id: 'inst-1',
    value_refs: [{ $var: { path: 'DS:Temp' } }, { $var: { path: 'DS:Arr', index: 1 } }],
    values: [80.04, 'x'],
  } as unknown as AlarmInstance;

  beforeEach(() => {
    useAlarmStore.setState({ active: [active] });
    useVariableStore.setState({ values: { 'DS:Temp': 91.26, 'DS:Arr': [1, 2] } });
  });

  it('reads an active alarm live and re-renders when its variable ticks', () => {
    const { result } = renderHook(() => useAlarmText());
    expect(result.current(TEXT, active)).toBe('Temp 91.3 at 2');
    act(() => useVariableStore.setState({ values: { 'DS:Temp': 12, 'DS:Arr': [1, 2] } }));
    expect(result.current(TEXT, active)).toBe('Temp 12.0 at 2');
  });

  it('shows the value stored at fire time once cleared, and — without one', () => {
    const { result } = renderHook(() => useAlarmText());
    expect(result.current(TEXT, { id: 'hist-1', values: [80.04, 'x'] })).toBe('Temp 80.0 at x');
    expect(result.current(TEXT, { id: 'hist-2', values: [] })).toBe('Temp — at —');
    expect(result.current(TEXT)).toBe(TEXT);
  });
});
