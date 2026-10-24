import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useVariablesDomainStore } from '@config/store/domains/variablesDomainStore';
import { useDatasourceBrowse } from './useDatasourceBrowse';
import type { TreeNode } from '@shared/types/datasource';

describe('useDatasourceBrowse', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useVariablesDomainStore.setState({ selectedName: null, pendingBrowse: {} });
  });

  it('does not apply a diff or set pendingBrowse when the active datasource changed mid-browse', async () => {
    useVariablesDomainStore.setState({ selectedName: 'A' });

    let resolveFetch!: (body: unknown) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = (body: unknown) =>
            resolve(
              new Response(JSON.stringify(body), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            );
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const latestTree = { current: [] as TreeNode[] };
    const applyTreeUpdate = vi.fn();

    const { result } = renderHook(() =>
      useDatasourceBrowse({ dsName: 'A', latestTree, applyTreeUpdate }),
    );

    const browsePromise = result.current.handleBrowse();

    // Simulate the user switching to datasource B while A's browse is
    // still in flight — latestTree is shared, so it now reflects B's tree.
    useVariablesDomainStore.setState({ selectedName: 'B' });
    latestTree.current = [
      { kind: 'variable', display_name: 'BVar', data_type: 'Float', enabled: true },
    ];

    resolveFetch({
      node_id: 'root',
      display_name: 'root',
      data_type: null,
      children: [{ node_id: 'n1', display_name: 'NewVar', data_type: 'Float' }],
    });
    await browsePromise;

    expect(applyTreeUpdate).not.toHaveBeenCalled();
    expect(useVariablesDomainStore.getState().pendingBrowse).toEqual({});
  });

  it('applies the diff normally when the datasource stays active', async () => {
    useVariablesDomainStore.setState({ selectedName: 'A' });

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            node_id: 'root',
            display_name: 'root',
            data_type: null,
            children: [{ node_id: 'n1', display_name: 'NewVar', data_type: 'Float' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const latestTree = { current: [] as TreeNode[] };
    const applyTreeUpdate = vi.fn();

    const { result } = renderHook(() =>
      useDatasourceBrowse({ dsName: 'A', latestTree, applyTreeUpdate }),
    );

    await result.current.handleBrowse();

    expect(useVariablesDomainStore.getState().pendingBrowse['A']).toBeDefined();
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
        vi.fn(
          async () =>
            new Response(JSON.stringify(result), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
        ),
      );
      const latestTree = { current: tree };
      const applyTreeUpdate = vi.fn();
      const { result: hook } = renderHook(() =>
        useDatasourceBrowse({ dsName: 'A', latestTree, applyTreeUpdate }),
      );
      await act(() => hook.current.handleBrowse());
      return { applyTreeUpdate };
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
});
