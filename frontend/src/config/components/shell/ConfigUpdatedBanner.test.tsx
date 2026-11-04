import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { publishConfigChanged, type ArtifactType } from '@shared/events/configChangedBus';
import { publishWidgetUpdated } from '@shared/events/widgetUpdatedBus';
import { useComponentStore } from '@shared/store/componentStore';
import { useConfigStore } from '@shared/store/configStore';
import { useProjectStore } from '@shared/store/projectStore';
import { useTranslationStore } from '@shared/store/translationStore';
import { TAB_ID } from '@shared/utils/api';
import { useAlarmConfigStore } from '@config/store/alarmConfigStore';
import { useRecipeConfigStore } from '@config/store/recipeConfigStore';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { useVariablesDomainStore } from '@config/store/domains/variablesDomainStore';
import { ConfigUpdatedBanner } from './ConfigUpdatedBanner';

const event = (artifact_type: ArtifactType, source: 'mcp' | 'rest' | 'api', tab_id?: string) => ({
  artifact_type,
  artifact_ids: [],
  source,
  summary: '',
  tab_id,
});

const LABEL = { id: 'gone', type: 'Label', name: 'Gone', properties: {}, layout: {} };
const FRESH_INDEX = { pages: [{ id: 'fresh', type: 'page', title: 'Fresh', sections: {} }] };

let fetchSpy: ReturnType<typeof vi.fn>;
let respond: (url: string) => unknown;

const banner = () => screen.queryByRole('status');
const requested = () => fetchSpy.mock.calls.map(([url]) => String(url));

beforeEach(() => {
  respond = () => FRESH_INDEX;
  fetchSpy = vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => respond(url),
  }));
  vi.stubGlobal('fetch', fetchSpy);
  useProjectStore.setState({ dirty: false, past: [], future: [] });
  useConfigStore.setState({ loaded: true });
  useComponentStore.setState({ loaded: true });
  useRecipeConfigStore.setState({ loaded: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('ignores a save this tab made itself', () => {
  render(<ConfigUpdatedBanner />);
  act(() => publishConfigChanged(event('page', 'rest', TAB_ID)));
  expect(banner()).not.toBeInTheDocument();
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('applies another editor tab’s save in place when nothing is unsaved', async () => {
  // Undo must not step back over the other tab's change.
  useProjectStore.setState({ past: [{} as never] });
  render(<ConfigUpdatedBanner />);

  act(() => publishConfigChanged(event('page', 'rest', 'another-tab')));

  await waitFor(() => expect(useConfigStore.getState().pages.map((p) => p.id)).toEqual(['fresh']));
  expect(requested()[0]).toContain('/api/config/config');
  await waitFor(() => expect(useProjectStore.getState().past).toEqual([]));
  expect(banner()).not.toBeInTheDocument();
});

it('drops a selected widget another writer deleted, and keeps the rest selected', async () => {
  useConfigStore.setState({
    pages: [{ id: 'fresh', type: 'page', title: 'Fresh', sections: { content: [LABEL] } }],
  });
  useEditorDomainStore.getState().setSelectedMany(['fresh', 'gone'], 'pages');
  render(<ConfigUpdatedBanner />);

  act(() => publishConfigChanged(event('page', 'mcp')));

  await waitFor(() => expect(useEditorDomainStore.getState().selectedIds).toEqual(['fresh']));
  expect(useEditorDomainStore.getState().selectedRegion).toBe('pages');
});

it('leaves the pages alone and warns when an edit lands during the fetch', async () => {
  let release!: () => void;
  respond = () => FRESH_INDEX;
  fetchSpy.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: true, status: 200, json: async () => FRESH_INDEX });
      }),
  );
  useConfigStore.setState({ pages: [{ id: 'mine', type: 'page', title: 'Mine', sections: {} }] });
  useProjectStore.setState({ past: [{} as never] });
  render(<ConfigUpdatedBanner />);

  act(() => publishConfigChanged(event('page', 'mcp')));
  act(() => useProjectStore.getState().markDirty());
  release();

  expect(await screen.findByRole('status')).toBeInTheDocument();
  expect(useConfigStore.getState().pages.map((p) => p.id)).toEqual(['mine']);
  expect(useProjectStore.getState().past).toHaveLength(1);
});

it('stops a burst at the edit instead of fetching over it in the next pass', async () => {
  let release!: () => void;
  fetchSpy.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: true, status: 200, json: async () => FRESH_INDEX });
      }),
  );
  useConfigStore.setState({ pages: [{ id: 'mine', type: 'page', title: 'Mine', sections: {} }] });
  render(<ConfigUpdatedBanner />);

  act(() => publishConfigChanged(event('page', 'mcp')));
  act(() => publishConfigChanged(event('page', 'mcp')));
  act(() => useProjectStore.getState().markDirty());
  release();

  expect(await screen.findByRole('status')).toBeInTheDocument();
  await act(async () => {});
  expect(useConfigStore.getState().pages.map((p) => p.id)).toEqual(['mine']);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

it('drops the undo steps from before a pass it applied, even when a later pass is skipped', async () => {
  const releases: Array<() => void> = [];
  fetchSpy.mockImplementation(
    () =>
      new Promise((resolve) => {
        releases.push(() => resolve({ ok: true, status: 200, json: async () => FRESH_INDEX }));
      }),
  );
  const before = { marker: 'before the other writer' } as never;
  useConfigStore.setState({ pages: [{ id: 'mine', type: 'page', title: 'Mine', sections: {} }] });
  useProjectStore.setState({ past: [before] });
  render(<ConfigUpdatedBanner />);

  act(() => publishConfigChanged(event('page', 'mcp')));
  act(() => publishConfigChanged(event('page', 'mcp')));
  releases[0]();
  await waitFor(() => expect(releases).toHaveLength(2));
  // The author edits while the second pass is out.
  act(() => useProjectStore.getState().runBatched(() => {}));
  releases[1]();

  expect(await screen.findByRole('status')).toBeInTheDocument();
  expect(useConfigStore.getState().pages.map((p) => p.id)).toEqual(['fresh']);
  expect(useProjectStore.getState().past).not.toContain(before);
});

it('picks up a datasource on a Variables screen that listed none yet', async () => {
  const refreshSelected = vi.fn().mockResolvedValue(undefined);
  useVariablesDomainStore.setState({ datasources: [], listLoaded: true, refreshSelected });
  render(<ConfigUpdatedBanner />);

  act(() => publishConfigChanged(event('datasource', 'rest', 'other')));

  await waitFor(() => expect(refreshSelected).toHaveBeenCalledOnce());
});

it('re-fetches a loaded domain store, and leaves an unopened one alone', async () => {
  const load = vi.fn().mockResolvedValue(undefined);
  useAlarmConfigStore.setState({ loaded: false, load });
  render(<ConfigUpdatedBanner />);

  act(() => publishConfigChanged(event('alarms', 'mcp')));
  await act(async () => {});
  expect(load).not.toHaveBeenCalled();

  useAlarmConfigStore.setState({ loaded: true });
  act(() => publishConfigChanged(event('alarms', 'mcp')));
  await waitFor(() => expect(load).toHaveBeenCalledOnce());
});

it('keeps undo history when the change is not part of it', async () => {
  useAlarmConfigStore.setState({ loaded: true, load: vi.fn().mockResolvedValue(undefined) });
  useProjectStore.setState({ past: [{} as never] });
  render(<ConfigUpdatedBanner />);

  act(() => publishConfigChanged(event('alarms', 'mcp')));
  await act(async () => {});

  expect(useProjectStore.getState().past).toHaveLength(1);
});

it('says nothing about a domain the editor never opened, even with unsaved edits', async () => {
  // An operator's recipe dataset upload from the live view.
  useProjectStore.setState({ dirty: true, past: [{} as never] });
  render(<ConfigUpdatedBanner />);

  act(() => publishConfigChanged(event('recipes', 'rest')));
  await act(async () => {});

  expect(banner()).not.toBeInTheDocument();
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(useProjectStore.getState().past).toHaveLength(1);
});

it('warns instead of applying when the editor has unsaved changes', () => {
  useProjectStore.setState({ dirty: true });
  render(<ConfigUpdatedBanner />);

  act(() => publishConfigChanged(event('page', 'api')));

  expect(screen.getByRole('status')).toHaveTextContent('Config was updated by another writer.');
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('follows a dictionary deleted elsewhere to the first one left, without forcing over edits', async () => {
  const loadTranslations = vi.fn().mockResolvedValue(undefined);
  useTranslationStore.setState({ loaded: true, activeDictionary: 'Line2', loadTranslations });
  respond = (url) =>
    url.includes('/dictionaries') ? [{ name: 'Default' }, { name: 'Line3' }] : {};
  render(<ConfigUpdatedBanner />);

  act(() => publishConfigChanged(event('translations', 'mcp')));

  await waitFor(() => expect(loadTranslations).toHaveBeenCalledWith());
  expect(useTranslationStore.getState().dictionaries).toEqual(['Default', 'Line3']);
  expect(useTranslationStore.getState().activeDictionary).toBe('Default');
});

it.each([
  ['page', '/api/config/config'],
  ['component', '/api/components'],
  ['theme', '/api/themes'],
] as const)('re-fetches a %s change from %s', async (type, path) => {
  render(<ConfigUpdatedBanner />);
  act(() => publishConfigChanged(event(type, 'mcp')));
  await waitFor(() => expect(requested()).toContainEqual(expect.stringContaining(path)));
});

it('folds a burst of saves into one more fetch after the one in flight', async () => {
  let release!: () => void;
  const load = vi
    .fn()
    .mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)))
    .mockResolvedValue(undefined);
  useComponentStore.setState({ load });
  render(<ConfigUpdatedBanner />);

  for (const id of ['a', 'b', 'c'])
    act(() => publishConfigChanged({ ...event('component', 'rest', 'other'), artifact_ids: [id] }));
  expect(load).toHaveBeenCalledTimes(1);

  release();
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  await act(async () => {});
  expect(load).toHaveBeenCalledTimes(2);
});

it.each([
  [false, 1, 0],
  [true, 0, 1],
] as const)(
  'on a recompiled custom widget with unsaved=%s, reloads %i time(s) and shows %i banner(s)',
  (dirty, reloads, banners) => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    useProjectStore.setState({ dirty });
    render(<ConfigUpdatedBanner />);

    act(() => publishWidgetUpdated({ key: 'Gauge', name: 'Gauge', ts: 't1', schema_ok: true }));

    expect(reload).toHaveBeenCalledTimes(reloads);
    expect(screen.queryAllByRole('status')).toHaveLength(banners);
    if (banners)
      expect(screen.getByRole('status')).toHaveTextContent('A custom widget was recompiled.');
  },
);
