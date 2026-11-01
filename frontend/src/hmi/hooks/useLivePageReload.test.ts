import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishConfigChanged } from '@shared/events/configChangedBus';
import { useConfigStore } from '@shared/store/configStore';
import { useTranslationStore } from '@shared/store/translationStore';
import { useLivePageReload } from './useLivePageReload';

function change(artifact_type: 'page' | 'translations' | 'alarms', artifact_ids: string[]) {
  act(() => publishConfigChanged({ artifact_type, artifact_ids, source: 'mcp', summary: '' }));
}

describe('useLivePageReload', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('re-reads the page index when the server reports a page changed', async () => {
    // A page created over MCP, and a widget added to the one on screen.
    const tile = { id: 'new-tile', type: 'Label', name: 'New', properties: {}, layout: {} };
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        pages: [
          { id: 'line', type: 'page', title: 'Line', sections: { main: [tile] } },
          { id: 'trends', type: 'page', title: 'Trends' },
        ],
        globalEvents: { onHmiLoaded: [] },
      }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    const { result } = renderHook(() => useLivePageReload());

    change('page', ['trends']);

    await waitFor(() => expect(result.current).toBe(1));
    expect(fetchSpy.mock.calls[0]?.[0]).toContain('/api/config/config');
    const { pages, loadedPageIds, globalEvents } = useConfigStore.getState();
    expect(pages.map((p) => p.id)).toEqual(['line', 'trends']);
    expect(loadedPageIds.has('line')).toBe(true);
    expect(globalEvents).toEqual({ onHmiLoaded: [] });
  });

  it('force-reloads translations, and ignores other artifacts after unmount', () => {
    const load = vi.fn().mockResolvedValue(undefined);
    useTranslationStore.setState({ loadTranslations: load });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { unmount } = renderHook(() => useLivePageReload());

    change('translations', ['Default']);
    change('alarms', ['w-210']);
    expect(load).toHaveBeenCalledWith({ force: true });
    expect(fetchSpy).not.toHaveBeenCalled();

    unmount();
    change('page', ['line']);
    change('translations', ['Default']);
    expect(load).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
