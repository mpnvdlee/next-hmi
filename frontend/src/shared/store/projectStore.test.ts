import { useProjectStore } from './projectStore';
import { useConfigStore } from './configStore';
import { useTranslationStore } from './translationStore';

describe('projectStore.saveAll', () => {
  beforeEach(() => {
    useProjectStore.setState({
      dirty: false,
      saving: false,
      saveError: null,
      _dirtySeq: 0,
      past: [],
      future: [],
      _saveCallbacks: new Map(),
    });
    // Neutral defaults — individual tests override the save methods they exercise.
    useConfigStore.setState({
      saveConfigToBackend: async () => true,
    });
    useTranslationStore.setState({ saveTranslations: async () => true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the project dirty when an edit lands during the in-flight save', async () => {
    useConfigStore.setState({
      saveConfigToBackend: async () => {
        // An edit dirties the project while the save is in flight.
        useProjectStore.getState().markDirty();
        return true;
      },
    });

    await useProjectStore.getState().saveAll();

    expect(useProjectStore.getState().dirty).toBe(true);
    expect(useProjectStore.getState().saveError).toBeNull();
  });

  it('clears dirty on a clean save with no concurrent edit', async () => {
    useProjectStore.setState({ dirty: true, _dirtySeq: 3 });

    await useProjectStore.getState().saveAll();

    expect(useProjectStore.getState().dirty).toBe(false);
  });

  it('names the failing area and its reason when a later save step fails', async () => {
    useConfigStore.setState({ saveConfigToBackend: async () => true });
    // Translations fail after config already succeeded.
    useTranslationStore.setState({
      saveTranslations: async () => false,
      error: 'Could not save translations.',
    });

    await useProjectStore.getState().saveAll();

    expect(useProjectStore.getState().saveError).toBe('Translations: Could not save translations.');
  });

  it('reports the config store reason when the config save fails', async () => {
    useConfigStore.setState({
      saveConfigToBackend: async () => {
        useConfigStore.setState({ saveError: 'Project folder is read-only' });
        return false;
      },
    });

    await useProjectStore.getState().saveAll();

    expect(useProjectStore.getState().saveError).toBe(
      'Pages & layout: Project folder is read-only',
    );
  });

  it('lists every failing area, not just the first', async () => {
    useProjectStore.getState().registerSave('alarms', async () => {
      throw new Error('HTTP 500');
    });
    useProjectStore.getState().registerSave('ds-vars-PLC1', async () => {
      throw new Error('Server unreachable');
    });

    await useProjectStore.getState().saveAll();

    expect(useProjectStore.getState().saveError).toBe(
      'Alarms: HTTP 500 · Variables of "PLC1": Server unreachable',
    );
  });

  it('clears the message on dismiss', async () => {
    useProjectStore.setState({ saveError: 'Alarms: HTTP 500' });

    useProjectStore.getState().dismissSaveError();

    expect(useProjectStore.getState().saveError).toBeNull();
  });
});
