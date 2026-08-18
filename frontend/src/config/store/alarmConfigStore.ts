import { create } from 'zustand';
import { useProjectStore } from '@shared/store/projectStore';
import { projectIsDirty } from '@shared/store/projectActions';
import { apiJson } from '@shared/utils/api';
import { slugId } from '@shared/utils/id';
import type { AlarmConfig, AlarmGroup, AlarmDefinition, AlarmTrigger } from '@shared/types/alarm';

export type AlarmSelection = { type: 'group'; id: string } | { type: 'alarm'; id: string } | null;

interface AlarmConfigState {
  config: AlarmConfig | null;
  loaded: boolean;
  selection: AlarmSelection;
  loadError: string | null;

  setSelection(sel: AlarmSelection): void;
  load(): Promise<void>;
  save(): Promise<void>;

  addGroup(title: string): void;
  deleteGroup(id: string): void;
  patchGroup(id: string, patch: Partial<Pick<AlarmGroup, 'title'>>): void;

  addAlarm(groupId: string): void;
  deleteAlarm(alarmId: string): void;
  patchAlarm(alarmId: string, patch: Partial<AlarmDefinition>): void;
}

const DEFAULT_TRIGGER: AlarmTrigger = {
  type: 'bool',
  source_value: undefined,
  min: null,
  max: null,
  on_true: true,
};

function createAlarmDefinition(taken: Iterable<string>): AlarmDefinition {
  return {
    id: slugId('New Alarm', taken),
    code: '',
    level: 'warning',
    title: 'New Alarm',
    description: '',
    image: '',
    auto_popup: false,
    resolutions: [],
    trigger: { ...DEFAULT_TRIGGER },
    ack_groups: [],
  };
}

export const useAlarmConfigStore = create<AlarmConfigState>((set, get) => ({
  config: null,
  loaded: false,
  selection: null,
  loadError: null,

  setSelection: (sel) => set({ selection: sel }),

  load: async () => {
    // Skip re-fetch when already loaded and there are unsaved local changes
    if (get().loaded && projectIsDirty()) return;
    try {
      const config = await apiJson<AlarmConfig>('/api/alarms/config');
      set({ config, loaded: true, loadError: null });
    } catch (err) {
      console.error('[alarmConfigStore] load failed:', err);
      set({ loadError: 'Could not load alarm configuration.' });
    }
  },

  save: async () => {
    const { config } = get();
    if (!config) return;
    const saved = await apiJson<AlarmConfig>('/api/alarms/config', { method: 'PUT', body: config });
    set({ config: saved });
  },

  addGroup: (title) => {
    const { config } = get();
    if (!config) return;
    const group: AlarmGroup = {
      id: slugId(
        title || 'group',
        config.groups.map((g) => g.id),
      ),
      title,
      alarms: [],
    };
    set({
      config: { ...config, groups: [...config.groups, group] },
      selection: { type: 'group', id: group.id },
    });
    useProjectStore.getState().markDirty();
  },

  deleteGroup: (id) => {
    const { config, selection } = get();
    if (!config) return;
    set({
      config: { ...config, groups: config.groups.filter((g) => g.id !== id) },
      selection: selection?.type === 'group' && selection.id === id ? null : selection,
    });
    useProjectStore.getState().markDirty();
  },

  patchGroup: (id, patch) => {
    const { config } = get();
    if (!config) return;
    set({
      config: {
        ...config,
        groups: config.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)),
      },
    });
    useProjectStore.getState().markDirty();
  },

  addAlarm: (groupId) => {
    const { config } = get();
    if (!config) return;
    const takenAlarmIds = config.groups.flatMap((g) => g.alarms.map((a) => a.id));
    const alarm = createAlarmDefinition(takenAlarmIds);
    set({
      config: {
        ...config,
        groups: config.groups.map((g) =>
          g.id === groupId ? { ...g, alarms: [...g.alarms, alarm] } : g,
        ),
      },
      selection: { type: 'alarm', id: alarm.id },
    });
    useProjectStore.getState().markDirty();
  },

  deleteAlarm: (alarmId) => {
    const { config, selection } = get();
    if (!config) return;
    set({
      config: {
        ...config,
        groups: config.groups.map((g) => ({
          ...g,
          alarms: g.alarms.filter((a) => a.id !== alarmId),
        })),
      },
      selection: selection?.type === 'alarm' && selection.id === alarmId ? null : selection,
    });
    useProjectStore.getState().markDirty();
  },

  patchAlarm: (alarmId, patch) => {
    const { config } = get();
    if (!config) return;
    set({
      config: {
        ...config,
        groups: config.groups.map((g) => ({
          ...g,
          alarms: g.alarms.map((a) => (a.id === alarmId ? { ...a, ...patch } : a)),
        })),
      },
    });
    useProjectStore.getState().markDirty();
  },
}));

// Register persistent save callback — runs at module load so Ctrl+S / Save button
// persists alarm config regardless of which config page is currently active.
useProjectStore.getState().registerSave('alarms', async () => {
  await useAlarmConfigStore.getState().save();
});
