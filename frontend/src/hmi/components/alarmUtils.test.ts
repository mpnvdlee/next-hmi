/**
 * The acknowledgement half of `alarmUtils` — the SDK's `ackAlarm` /
 * `ackAllAlarms`.
 *
 * They carry `useWriteVariable`'s error contract — never reject, report a
 * refusal per `onError` — over the WebSocket, which is what these tests pin.
 */
import { act, renderHook } from '@testing-library/react';
import type { AlarmInstance } from '@shared/types/alarm';
import { useAlarmStore } from '@hmi/store/alarmStore';
import { useHmiStore } from '@hmi/store/hmiStore';
import { useVariableStore } from '@hmi/store/variableStore';
import { sendWsMessage } from '@hmi/hooks/useWebSocket';
import { resolvePending } from '@hmi/utils/actionDispatcher';
import { ackAlarm, ackAllAlarms, useAlarmText } from './alarmUtils';

vi.mock('@hmi/hooks/useWebSocket', () => ({ sendWsMessage: vi.fn() }));

function toasts() {
  return useHmiStore.getState().pendingToasts;
}

/** The frame the last ack sent. */
function sent(): Record<string, unknown> {
  return vi.mocked(sendWsMessage).mock.lastCall?.[0] as Record<string, unknown>;
}

/** Answer the last ack the way the backend would. */
function answer(ok: boolean, reason?: string) {
  resolvePending(String(sent().requestId), reason ? { reason } : {}, ok);
}

beforeEach(() => {
  vi.mocked(sendWsMessage).mockReset().mockReturnValue(true);
  useHmiStore.setState({ pendingToasts: [] });
});

describe('ackAlarm', () => {
  it('sends the acknowledgement without a username and resolves true', async () => {
    const result = ackAlarm('inst-1', 'operator');
    expect(sent()).toMatchObject({ type: 'alarm_ack', instanceId: 'inst-1' });
    expect(sent()).not.toHaveProperty('username');

    answer(true);

    await expect(result).resolves.toBe(true);
    expect(toasts()).toHaveLength(0);
  });

  it('resolves false and toasts the reason when the backend refuses', async () => {
    const result = ackAlarm('inst-1');
    answer(false, 'not_found');

    await expect(result).resolves.toBe(false);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].severity).toBe('error');
    expect(toasts()[0].message).toBe('Could not acknowledge: The alarm is no longer active');
  });

  it('fails at once, as disconnected, when the socket is not open', async () => {
    vi.mocked(sendWsMessage).mockReturnValue(false);

    await expect(ackAlarm('inst-1')).resolves.toBe(false);
    expect(toasts()[0].message).toMatch(/Not connected to the server/);
  });

  it('reuses one toast per instance, and gives a second instance its own', async () => {
    void ackAlarm('inst-1');
    answer(false, 'disconnected');
    void ackAlarm('inst-1');
    answer(false, 'disconnected');
    expect(toasts()).toHaveLength(1);

    void ackAlarm('inst-2');
    answer(false, 'disconnected');
    expect(toasts()).toHaveLength(2);
  });

  it('honours onError: silent and the callback form', async () => {
    const silent = ackAlarm('inst-1', 'operator', { onError: 'silent' });
    answer(false, 'not_found');
    await expect(silent).resolves.toBe(false);
    expect(toasts()).toHaveLength(0);

    const reasons: string[] = [];
    void ackAlarm('inst-1', 'operator', { onError: (reason) => reasons.push(reason) });
    answer(false, 'not_found');
    expect(reasons).toEqual(['not_found']);
    expect(toasts()).toHaveLength(0);
  });
});

describe('ackAllAlarms', () => {
  it('sends the acknowledgement and resolves true', async () => {
    const result = ackAllAlarms();
    expect(sent()).toMatchObject({ type: 'alarm_ack_all' });

    answer(true);

    await expect(result).resolves.toBe(true);
  });

  it('resolves false and toasts once however often it is refused', async () => {
    const first = ackAllAlarms();
    answer(false, 'timeout');
    await expect(first).resolves.toBe(false);
    void ackAllAlarms();
    answer(false, 'timeout');

    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].message).toMatch(/The server did not respond/);
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

describe('useAlarmText placeholders on array and struct-array elements', () => {
  // As the backend caches them: a struct array counted from 1, each member of
  // an element under its own leaf key (the binding picker's shape for it).
  const TEXT = '{1} / {2} / {3} / {4}';
  const active = {
    id: 'inst-1',
    value_refs: [
      { $var: { path: 'DS:Stations/Stations[3]/Temp' } },
      { $var: { path: 'DS:Arr', index: 2 } },
      { $var: { path: 'DS:Arr', index: { $static: 3 } } },
      { $var: { path: 'DS:Arr', index: { $var: { path: 'DS:Idx' } } } },
    ],
    values: [33, 2.5, 3.5, 1.5],
  } as unknown as AlarmInstance;
  const values = {
    'DS:Stations': [{ Temp: 0 }, { Temp: 0 }, { Temp: 33 }],
    'DS:Stations/Stations[3]': { Temp: 33 },
    'DS:Stations/Stations[3]/Temp': 33,
    'DS:Arr': [0.5, 1.5, 2.5, 3.5],
    'DS:Idx': 1,
  };

  beforeEach(() => {
    useAlarmStore.setState({ active: [active] });
    useVariableStore.setState({ values });
  });

  it('reads them live, following the member, the array and a bound index', () => {
    const { result } = renderHook(() => useAlarmText());
    expect(result.current(TEXT, active)).toBe('33 / 2.5 / 3.5 / 1.5');
    act(() =>
      useVariableStore.setState({
        values: { ...values, 'DS:Stations/Stations[3]/Temp': 40, 'DS:Idx': 0 },
      }),
    );
    expect(result.current(TEXT, active)).toBe('40 / 2.5 / 3.5 / 0.5');
  });

  it('shows the values captured at fire time once cleared', () => {
    const { result } = renderHook(() => useAlarmText());
    expect(result.current(TEXT, { id: 'hist-1', values: [33, 2.5, 3.5, 1.5] })).toBe(
      '33 / 2.5 / 3.5 / 1.5',
    );
  });
});
