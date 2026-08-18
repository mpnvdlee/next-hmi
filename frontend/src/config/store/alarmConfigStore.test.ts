import { useProjectStore } from '@shared/store/projectStore';
import { useAlarmConfigStore } from './alarmConfigStore';
import type { AlarmConfig } from '@shared/types/alarm';

const EMPTY_CONFIG: AlarmConfig = { version: 1, groups: [] };

const CONFIG_WITH_GROUP: AlarmConfig = {
  version: 1,
  groups: [
    {
      id: 'g1',
      title: 'Pumps',
      alarms: [],
    },
  ],
};

beforeEach(() => {
  useAlarmConfigStore.setState({
    config: null,
    loaded: false,
    selection: null,
    loadError: null,
  });
  useProjectStore.setState({
    dirty: false,
    saving: false,
    saveError: null,
    past: [],
    future: [],
    _saveCallbacks: useProjectStore.getState()._saveCallbacks,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── Mutations mark project dirty ──────────────────────────────────────────────

describe('mutations', () => {
  it('addGroup marks project dirty', () => {
    useAlarmConfigStore.setState({ config: EMPTY_CONFIG, loaded: true });
    useAlarmConfigStore.getState().addGroup('New Group');
    expect(useProjectStore.getState().dirty).toBe(true);
  });

  it('addGroup appends group and sets selection', () => {
    useAlarmConfigStore.setState({ config: EMPTY_CONFIG, loaded: true });
    useAlarmConfigStore.getState().addGroup('Motors');
    const { config, selection } = useAlarmConfigStore.getState();
    expect(config!.groups).toHaveLength(1);
    expect(config!.groups[0].title).toBe('Motors');
    expect(selection?.type).toBe('group');
  });

  it('deleteGroup removes group and clears selection if it was selected', () => {
    useAlarmConfigStore.setState({
      config: CONFIG_WITH_GROUP,
      loaded: true,
      selection: { type: 'group', id: 'g1' },
    });
    useAlarmConfigStore.getState().deleteGroup('g1');
    const { config, selection } = useAlarmConfigStore.getState();
    expect(config!.groups).toHaveLength(0);
    expect(selection).toBeNull();
  });

  it('deleteGroup preserves selection when a different group is deleted', () => {
    const configWith2 = {
      version: 1,
      groups: [
        { id: 'g1', title: 'A', alarms: [] },
        { id: 'g2', title: 'B', alarms: [] },
      ],
    };
    useAlarmConfigStore.setState({
      config: configWith2,
      loaded: true,
      selection: { type: 'group', id: 'g2' },
    });
    useAlarmConfigStore.getState().deleteGroup('g1');
    expect(useAlarmConfigStore.getState().selection).toEqual({ type: 'group', id: 'g2' });
  });

  it('patchGroup updates only the specified group', () => {
    useAlarmConfigStore.setState({ config: CONFIG_WITH_GROUP, loaded: true });
    useAlarmConfigStore.getState().patchGroup('g1', { title: 'Renamed' });
    expect(useAlarmConfigStore.getState().config!.groups[0].title).toBe('Renamed');
  });

  it('addAlarm appends alarm to group and sets selection', () => {
    useAlarmConfigStore.setState({ config: CONFIG_WITH_GROUP, loaded: true });
    useAlarmConfigStore.getState().addAlarm('g1');
    const { config, selection } = useAlarmConfigStore.getState();
    expect(config!.groups[0].alarms).toHaveLength(1);
    expect(selection?.type).toBe('alarm');
  });

  it('deleteAlarm removes alarm from group', () => {
    useAlarmConfigStore.setState({ config: CONFIG_WITH_GROUP, loaded: true });
    useAlarmConfigStore.getState().addAlarm('g1');
    const alarmId = useAlarmConfigStore.getState().config!.groups[0].alarms[0].id;
    useAlarmConfigStore.getState().deleteAlarm(alarmId);
    expect(useAlarmConfigStore.getState().config!.groups[0].alarms).toHaveLength(0);
  });
});

// ── registerSave callback ─────────────────────────────────────────────────────

describe('registerSave callback', () => {
  it('is registered as "alarms" in projectStore', () => {
    const cb = useProjectStore.getState()._saveCallbacks.get('alarms');
    expect(cb).toBeTruthy();
  });

  it('calls PUT /api/alarms/config with current config', async () => {
    const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === '/api/alarms/config' && opts?.method === 'PUT') {
        return { ok: true, json: async () => CONFIG_WITH_GROUP };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);

    useAlarmConfigStore.setState({ config: CONFIG_WITH_GROUP, loaded: true });

    const saveCb = useProjectStore.getState()._saveCallbacks.get('alarms')!;
    await saveCb();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/alarms/config',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('skips saving when config is null (not loaded)', async () => {
    // When config is null, save() returns early without calling fetch
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const saveCb = useProjectStore.getState()._saveCallbacks.get('alarms')!;
    await saveCb(); // should not throw and should not call fetch
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws backend detail message when save fails', async () => {
    const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === '/api/alarms/config' && opts?.method === 'PUT') {
        return { ok: false, json: async () => ({ detail: 'disk full' }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);

    useAlarmConfigStore.setState({ config: CONFIG_WITH_GROUP, loaded: true });

    const saveCb = useProjectStore.getState()._saveCallbacks.get('alarms')!;
    await expect(saveCb()).rejects.toThrow('disk full');
  });

  it('throws fallback message when save response has no detail', async () => {
    const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === '/api/alarms/config' && opts?.method === 'PUT') {
        return { ok: false, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);

    useAlarmConfigStore.setState({ config: CONFIG_WITH_GROUP, loaded: true });

    const saveCb = useProjectStore.getState()._saveCallbacks.get('alarms')!;
    await expect(saveCb()).rejects.toThrow();
  });
});
