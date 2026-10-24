import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useVariablesDomainStore } from '@config/store/domains/variablesDomainStore';
import { nextBrowsePercent, useDatasourceBrowse } from './useDatasourceBrowse';
import type { TreeNode } from '@shared/types/datasource';

const TREE = {
  node_id: 'root',
  display_name: 'root',
  data_type: null,
  children: [{ node_id: 'n1', display_name: 'NewVar', data_type: 'Float' }],
};

/** A streamed browse response: one NDJSON line per object. */
function ndjsonResponse(lines: object[]): Response {
  return new Response(lines.map((line) => JSON.stringify(line) + '\n').join(''), {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}

function renderBrowse(dsName = 'A') {
  const latestTree = { current: [] as TreeNode[] };
  const applyTreeUpdate = vi.fn();
  const hook = renderHook(
    ({ name }: { name: string }) =>
      useDatasourceBrowse({ dsName: name, latestTree, applyTreeUpdate }),
    { initialProps: { name: dsName } },
  );
  return { ...hook, latestTree, applyTreeUpdate };
}

describe('useDatasourceBrowse', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useVariablesDomainStore.setState({ selectedName: null, pendingBrowse: {} });
  });

  it('does not apply a diff or set pendingBrowse when the active datasource changed mid-browse', async () => {
    useVariablesDomainStore.setState({ selectedName: 'A' });

    let resolveFetch!: (lines: object[]) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = (lines: object[]) => resolve(ndjsonResponse(lines));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result, latestTree, applyTreeUpdate } = renderBrowse();
    const browsePromise = result.current.handleBrowse();

    // Simulate the user switching to datasource B while A's browse is
    // still in flight — latestTree is shared, so it now reflects B's tree.
    useVariablesDomainStore.setState({ selectedName: 'B' });
    latestTree.current = [
      { kind: 'variable', display_name: 'BVar', data_type: 'Float', enabled: true },
    ];

    resolveFetch([{ type: 'result', tree: TREE }]);
    await browsePromise;

    expect(applyTreeUpdate).not.toHaveBeenCalled();
    expect(useVariablesDomainStore.getState().pendingBrowse).toEqual({});
  });

  it('applies the diff normally when the datasource stays active', async () => {
    useVariablesDomainStore.setState({ selectedName: 'A' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ndjsonResponse([{ type: 'result', tree: TREE }])),
    );

    const { result } = renderBrowse();
    await act(() => result.current.handleBrowse());

    expect(useVariablesDomainStore.getState().pendingBrowse['A']).toBeDefined();
  });

  it('reads the streamed endpoint', async () => {
    useVariablesDomainStore.setState({ selectedName: 'A' });
    const fetchMock = vi.fn(async (_url: string) =>
      ndjsonResponse([{ type: 'result', tree: TREE }]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderBrowse('Line 1');
    await act(() => result.current.handleBrowse());

    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/datasources/Line%201/browse/stream');
  });

  it('reports progress while the walk runs, and clears it when done', async () => {
    useVariablesDomainStore.setState({ selectedName: 'A' });

    // A stream the test feeds by hand, so progress can be observed mid-walk.
    let push!: (line: object) => void;
    let close!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        push = (line) => controller.enqueue(encoder.encode(JSON.stringify(line) + '\n'));
        close = () => controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })),
    );

    const { result } = renderBrowse();
    expect(result.current.progress).toBeNull();

    let browse!: Promise<void>;
    act(() => {
      browse = result.current.handleBrowse();
    });
    // Before the first report: indeterminate.
    expect(result.current.progress).toEqual({ percent: null, nodes: 0, level: 0 });

    act(() => push({ type: 'progress', done: 30, total: 120, nodes: 412, level: 2 }));
    await waitFor(() =>
      expect(result.current.progress).toEqual({ percent: 25, nodes: 412, level: 2 }),
    );
    expect(result.current.browsing).toBe(true);

    act(() => {
      push({ type: 'result', tree: TREE });
      close();
    });
    await act(() => browse);

    expect(result.current.progress).toBeNull();
    expect(result.current.browsing).toBe(false);
  });

  it('surfaces a failure the server reports mid-walk', async () => {
    useVariablesDomainStore.setState({ selectedName: 'A' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ndjsonResponse([
          { type: 'progress', done: 1, total: 4, nodes: 3, level: 1 },
          { type: 'error', error: 'BadSessionClosed' },
        ]),
      ),
    );

    const { result } = renderBrowse();
    await act(() => result.current.handleBrowse());

    expect(result.current.browseError).toBe('BadSessionClosed');
    expect(useVariablesDomainStore.getState().pendingBrowse).toEqual({});
  });

  describe('a saved tag the browse did not walk', () => {
    const SPEED: TreeNode = {
      kind: 'variable',
      node_id: 'ns=2;s=Speed',
      display_name: 'Speed',
      data_type: 'Double',
      enabled: true,
      writable: false,
    };
    const savedTree = (stale: boolean): TreeNode[] => [
      {
        kind: 'variable',
        node_id: 'ns=2;s=Level',
        display_name: 'Level',
        data_type: 'Double',
        enabled: true,
        writable: false,
        ...(stale && { present_on_server: false }),
      },
      { kind: 'folder', name: 'Plant', node_id: 'ns=2;s=Plant', children: [SPEED] },
    ];
    // An explicit browse root: only Plant is walked.
    const browsed = (presentOutside?: string[]) => ({
      node_id: 'ns=2;s=Plant',
      display_name: 'Plant',
      data_type: null,
      show_root: true,
      ...(presentOutside && { present_outside_browse: presentOutside }),
      children: [
        { node_id: 'ns=2;s=Speed', display_name: 'Speed', data_type: 'Double', writable: false },
      ],
    });

    async function browseOver(tree: TreeNode[], result: object) {
      useVariablesDomainStore.setState({ selectedName: 'A' });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ndjsonResponse([{ type: 'result', tree: result }])),
      );
      const rendered = renderBrowse();
      rendered.latestTree.current = tree;
      await act(() => rendered.result.current.handleBrowse());
      return rendered;
    }

    it('is not offered as removed when the server says it is still there', async () => {
      const { applyTreeUpdate } = await browseOver(savedTree(false), browsed(['ns=2;s=Level']));

      expect(useVariablesDomainStore.getState().pendingBrowse['A']).toBeUndefined();
      expect(applyTreeUpdate).not.toHaveBeenCalled();
    });

    it('would otherwise be listed as removed from the server', async () => {
      await browseOver(savedTree(false), browsed());

      const pending = useVariablesDomainStore.getState().pendingBrowse['A'];
      expect(pending?.diff.removed.map((r) => r.node_id)).toEqual(['ns=2;s=Level']);
    });

    it('is brought back if an earlier browse had marked it stale', async () => {
      const tree = savedTree(true);
      const { applyTreeUpdate } = await browseOver(tree, browsed(['ns=2;s=Level']));

      expect(useVariablesDomainStore.getState().pendingBrowse['A']).toBeUndefined();
      expect(applyTreeUpdate).toHaveBeenCalledTimes(1);
      const updater = applyTreeUpdate.mock.calls[0][0] as (prev: TreeNode[]) => TreeNode[];
      expect(updater(tree)).toEqual(savedTree(false));
    });
  });

  it('cancels the walk when the user leaves the datasource', async () => {
    useVariablesDomainStore.setState({ selectedName: 'A' });
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            signal = init?.signal ?? undefined;
            signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      ),
    );

    const { result, rerender } = renderBrowse('A');
    let browse!: Promise<void>;
    act(() => {
      browse = result.current.handleBrowse();
    });
    await waitFor(() => expect(signal).toBeDefined());

    rerender({ name: 'B' });
    await act(() => browse);

    expect(signal?.aborted).toBe(true);
    // An abort is the user's doing, not an error to report.
    expect(result.current.browseError).toBeNull();
    expect(result.current.browsing).toBe(false);
  });
});

describe('nextBrowsePercent', () => {
  it('is the share of the work known so far', () => {
    expect(nextBrowsePercent(null, 1, 4)).toBe(25);
  });

  it('holds rather than jump back when a level reveals more work', () => {
    // 50% known done, then a large subtree appears: 60 of 200 is 30%.
    expect(nextBrowsePercent(50, 60, 200)).toBe(50);
  });

  it('stops at 99 until the tree is actually in hand', () => {
    expect(nextBrowsePercent(80, 500, 500)).toBe(99);
  });

  it('copes with a report before any total is known', () => {
    expect(nextBrowsePercent(null, 0, 0)).toBe(0);
  });
});
