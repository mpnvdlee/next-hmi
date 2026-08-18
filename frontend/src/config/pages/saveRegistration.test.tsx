import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useProjectStore } from '@shared/store/projectStore';
import { useConfigStore } from '@shared/store/configStore';
import { useTranslationStore } from '@shared/store/translationStore';
import { useAlarmConfigStore } from '../store/alarmConfigStore';
import { useRecipeConfigStore } from '../store/recipeConfigStore';
import { useHistorianConfigStore } from '../store/historianConfigStore';
import { useThemeViewStore } from '../store/themeViewStore';
import { useUsersDomainStore } from '../store/domains/usersDomainStore';
import AlarmsView from './AlarmsView';
import RecipesView from './RecipesView';

/**
 * The config pages are code-split, so their stores register their global-save
 * callback at chunk load and never unregister. This file owns that contract:
 * once a page has been visited, Ctrl+S must still persist its data from any
 * other page.
 */

const REGISTERED_BY_PAGE_CHUNKS = ['alarms', 'recipes', 'historian', 'theme'];

/** The registry as the imported chunks left it — restored per test, since some
 *  cases swap individual callbacks out. */
const CHUNK_SAVES = new Map(useProjectStore.getState()._saveCallbacks);

function saveKeys(): string[] {
  return [...useProjectStore.getState()._saveCallbacks.keys()];
}

beforeEach(() => {
  useProjectStore.setState({ _saveCallbacks: new Map(CHUNK_SAVES) });
  useConfigStore.setState({ saveConfigToBackend: async () => true });
  useTranslationStore.setState({ saveTranslations: async () => true });
  useProjectStore.setState({ dirty: false, saving: false, saveError: null, _dirtySeq: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('save registration across lazy page chunks', () => {
  it('registers a save callback for every feature page plus the always-loaded components save', () => {
    expect(saveKeys()).toEqual(
      expect.arrayContaining([...REGISTERED_BY_PAGE_CHUNKS, 'components']),
    );
  });

  it('fans a global save out to every registered page callback', async () => {
    const calls: string[] = [];
    for (const key of REGISTERED_BY_PAGE_CHUNKS) {
      useProjectStore.getState().registerSave(key, async () => {
        calls.push(key);
      });
    }

    await useProjectStore.getState().saveAll();

    expect(calls.sort()).toEqual([...REGISTERED_BY_PAGE_CHUNKS].sort());
  });

  it('reports a failing page save without clearing the dirty flag', async () => {
    useProjectStore.setState({ dirty: true, _dirtySeq: 1 });
    useProjectStore.getState().registerSave('alarms', async () => {
      throw new Error('PUT /api/alarms/config failed');
    });

    await useProjectStore.getState().saveAll();

    expect(useProjectStore.getState().saveError).toBe('Alarms: PUT /api/alarms/config failed');
    expect(useProjectStore.getState().dirty).toBe(true);
  });

  it('keeps a page save registered after the page unmounts', async () => {
    useAlarmConfigStore.setState({
      config: { version: 1, groups: [], settings: undefined } as never,
      loaded: true,
      loadError: null,
      selection: null,
    });
    useUsersDomainStore.setState({ ensureLoaded: vi.fn() });
    vi.spyOn(useAlarmConfigStore.getState(), 'load').mockResolvedValue(undefined);

    const view = render(
      <MemoryRouter>
        <AlarmsView />
      </MemoryRouter>,
    );
    await waitFor(() => expect(saveKeys()).toContain('alarms'));
    view.unmount();

    expect(saveKeys()).toContain('alarms');
  });

  it('routes each registered key to its own store save', async () => {
    const alarmSave = vi.spyOn(useAlarmConfigStore.getState(), 'save').mockResolvedValue();
    const recipeSave = vi.spyOn(useRecipeConfigStore.getState(), 'save').mockResolvedValue();
    const historianSave = vi.spyOn(useHistorianConfigStore.getState(), 'save').mockResolvedValue();
    useThemeViewStore.setState({ drafts: {} });

    await useProjectStore.getState().saveAll();

    expect(alarmSave).toHaveBeenCalled();
    expect(recipeSave).toHaveBeenCalled();
    expect(historianSave).toHaveBeenCalled();
  });

  it('skips the theme write entirely when no theme draft is pending', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    useThemeViewStore.setState({ drafts: {} });
    vi.spyOn(useAlarmConfigStore.getState(), 'save').mockResolvedValue();
    vi.spyOn(useRecipeConfigStore.getState(), 'save').mockResolvedValue();
    vi.spyOn(useHistorianConfigStore.getState(), 'save').mockResolvedValue();

    await useProjectStore.getState().saveAll();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('page mounts do not disturb each other', () => {
  it('mounting a second feature page leaves the first page save registered', async () => {
    useAlarmConfigStore.setState({
      config: { version: 1, groups: [], settings: undefined } as never,
      loaded: true,
      loadError: null,
      selection: null,
    });
    useRecipeConfigStore.setState({
      config: { version: 1, datasetTypes: [] },
      loaded: true,
      loadError: null,
      selection: null,
    });
    useUsersDomainStore.setState({ ensureLoaded: vi.fn() });
    vi.spyOn(useAlarmConfigStore.getState(), 'load').mockResolvedValue(undefined);
    vi.spyOn(useRecipeConfigStore.getState(), 'load').mockResolvedValue(undefined);

    const alarms = render(
      <MemoryRouter>
        <AlarmsView />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getAllByText('Alarms').length).toBeGreaterThan(0));
    alarms.unmount();

    render(
      <MemoryRouter>
        <RecipesView />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getAllByText('Recipes').length).toBeGreaterThan(0));

    expect(saveKeys()).toEqual(expect.arrayContaining(['alarms', 'recipes']));
  });
});
