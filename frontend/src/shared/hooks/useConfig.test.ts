import { afterEach, describe, expect, it, vi } from 'vitest';
import { useConfigStore } from '@shared/store/configStore';
import { loadConfigIndex } from './useConfig';

describe('loadConfigIndex', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('leaves no page dirty, so a save writes back only what the user touched', async () => {
    // The index carries every page's content; marking those dirty made the next
    // save overwrite pages another writer (an MCP edit) changed meanwhile.
    const widget = (id: string) => ({ id, type: 'Label', name: id, properties: {}, layout: {} });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          pages: [{ id: 'line', type: 'page', title: 'Line', sections: { main: [widget('w')] } }],
          dialogs: [
            { id: 'ask', type: 'page', title: 'Ask', sections: { content: [widget('b')] } },
          ],
          revision: 'idx',
          pageRevisions: { line: 'r-line', ask: 'r-ask' },
        }),
      }),
    );

    await loadConfigIndex();

    const state = useConfigStore.getState();
    expect([...state.loadedPageIds].sort()).toEqual(['ask', 'line']);
    expect(state.dirtyPageIds.size).toBe(0);
    expect(state.indexRevision).toBe('idx');
    expect(state.pageRevisions).toEqual({ line: 'r-line', ask: 'r-ask' });
  });
});
