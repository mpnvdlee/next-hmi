import { useAlarmStore } from './alarmStore';
import type { AlarmInstance, AlarmSummary } from '@shared/types/alarm';

const SUMMARY: AlarmSummary = {
  total: 5,
  unacked: 3,
  error_count: 2,
  warning_count: 2,
  info_count: 1,
};

function alarm(overrides: Partial<AlarmInstance> = {}): AlarmInstance {
  return {
    id: 'a1',
    alarm_id: 'alarm-1',
    code: 'HIGH_TEMP',
    level: 'error',
    title: 'High temp',
    description: '',
    image: '',
    resolutions: [],
    group_title: 'Pumps',
    auto_popup: false,
    ack_groups: [],
    triggered_at: '2024-01-01T00:00:00Z',
    acked: false,
    acked_by: '',
    acked_at: '',
    ...overrides,
  };
}

const INITIAL = useAlarmStore.getState();

beforeEach(() => {
  useAlarmStore.setState(INITIAL);
});

describe('setAlarmState', () => {
  it('replaces both active alarms and the summary', () => {
    const active = [alarm(), alarm({ id: 'a2' })];
    useAlarmStore.getState().setAlarmState(active, SUMMARY);

    const state = useAlarmStore.getState();
    expect(state.active).toEqual(active);
    expect(state.summary).toEqual(SUMMARY);
  });

  it('overwrites a previous state entirely rather than merging', () => {
    useAlarmStore.getState().setAlarmState([alarm()], SUMMARY);
    useAlarmStore.getState().setAlarmState([], { ...SUMMARY, total: 0 });

    const state = useAlarmStore.getState();
    expect(state.active).toEqual([]);
    expect(state.summary.total).toBe(0);
  });
});

describe('getCount', () => {
  beforeEach(() => {
    useAlarmStore.getState().setAlarmState([alarm(), alarm({ id: 'a2' })], SUMMARY);
  });

  it('returns the total for "all"', () => {
    expect(useAlarmStore.getState().getCount('all')).toBe(5);
  });

  it('returns unacked count', () => {
    expect(useAlarmStore.getState().getCount('unacked')).toBe(3);
  });

  it('returns severity-specific counts', () => {
    expect(useAlarmStore.getState().getCount('error')).toBe(2);
    expect(useAlarmStore.getState().getCount('warning')).toBe(2);
    expect(useAlarmStore.getState().getCount('info')).toBe(1);
  });

  it('returns zero for every filter when there are no alarms', () => {
    useAlarmStore.getState().setAlarmState([], {
      total: 0,
      unacked: 0,
      error_count: 0,
      warning_count: 0,
      info_count: 0,
    });

    expect(useAlarmStore.getState().getCount('all')).toBe(0);
    expect(useAlarmStore.getState().getCount('unacked')).toBe(0);
    expect(useAlarmStore.getState().getCount('error')).toBe(0);
    expect(useAlarmStore.getState().getCount('warning')).toBe(0);
    expect(useAlarmStore.getState().getCount('info')).toBe(0);
  });
});
