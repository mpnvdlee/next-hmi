import { create } from 'zustand';
import type { AlarmCountFilter, AlarmInstance, AlarmSummary } from '@shared/types/alarm';

interface AlarmStore {
  active: AlarmInstance[];
  summary: AlarmSummary;
  setAlarmState(active: AlarmInstance[], summary: AlarmSummary): void;
  getCount(filter: AlarmCountFilter): number;
}

const EMPTY_SUMMARY: AlarmSummary = {
  total: 0,
  unacked: 0,
  error_count: 0,
  warning_count: 0,
  info_count: 0,
};

export const useAlarmStore = create<AlarmStore>((set, get) => ({
  active: [],
  summary: EMPTY_SUMMARY,

  setAlarmState: (active, summary) => set({ active, summary }),

  getCount: (filter) => {
    const s = get().summary;
    switch (filter) {
      case 'all':
        return s.total;
      case 'unacked':
        return s.unacked;
      case 'error':
        return s.error_count;
      case 'warning':
        return s.warning_count;
      case 'info':
        return s.info_count;
      default:
        return 0;
    }
  },
}));
