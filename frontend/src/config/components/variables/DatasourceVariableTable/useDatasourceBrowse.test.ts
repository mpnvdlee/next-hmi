import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useVariablesDomainStore } from '@config/store/domains/variablesDomainStore';
import { useDatasourceBrowse } from './useDatasourceBrowse';
import type { TreeNode } from '@shared/types/datasource';

describe('useDatasourceBrowse', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useVariablesDomainStore.setState({ selectedName: null, pendingBrowse: {} });
  });

  it('does not apply a diff or set pendingBrowse when the active datasource changed mid-browse (§3.2)', async () => {
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
});
