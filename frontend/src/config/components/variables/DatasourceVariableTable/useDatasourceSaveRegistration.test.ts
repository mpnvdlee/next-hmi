import { renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useProjectStore } from '@shared/store/projectStore';
import { useDatasourceSaveRegistration } from './useDatasourceSaveRegistration';
import type { TreeNode } from '@shared/types/datasource';

const treeA: TreeNode[] = [
  { kind: 'variable', display_name: 'A', data_type: 'Float', enabled: true },
];
const treeB: TreeNode[] = [
  { kind: 'variable', display_name: 'B', data_type: 'Float', enabled: true },
];

describe('useDatasourceSaveRegistration', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps a newer edit and stays dirty when it lands during an in-flight save (§3.1)', async () => {
    let resolveFetch!: () => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = () => resolve(new Response(null, { status: 204 }));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const setDirtyCalls: boolean[] = [];
    const clearVarsDraftCalls: string[] = [];
    const onVariablesChangeCalls: TreeNode[][] = [];

    const { result, unmount } = renderHook(() => {
      const latestTree = useRef<TreeNode[]>(treeA);
      useDatasourceSaveRegistration({
        dsName: 'DS',
        latestTree,
        dirtyRef: { current: true },
        clearVarsDraft: (name) => clearVarsDraftCalls.push(name),
        onVariablesChange: (vars) => onVariablesChangeCalls.push(vars),
        setDirty: (v) => setDirtyCalls.push(v),
      });
      return latestTree;
    });

    const latestTree = result.current;
    const saveFn = useProjectStore.getState()._saveCallbacks.get('ds-vars-DS');
    expect(saveFn).toBeDefined();

    const savePromise = saveFn!();

    // Simulate the user editing again while the PUT is in flight.
    latestTree.current = treeB;

    resolveFetch();
    await savePromise;

    expect(setDirtyCalls).toEqual([]);
    expect(clearVarsDraftCalls).toEqual([]);
    expect(onVariablesChangeCalls).toEqual([]);
    expect(latestTree.current).toBe(treeB);

    unmount();
  });

  it('clears dirty and applies the sent tree when no newer edit lands', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );

    const setDirtyCalls: boolean[] = [];
    const clearVarsDraftCalls: string[] = [];
    const onVariablesChangeCalls: TreeNode[][] = [];

    const { unmount } = renderHook(() => {
      const latestTree = useRef<TreeNode[]>(treeA);
      useDatasourceSaveRegistration({
        dsName: 'DS2',
        latestTree,
        dirtyRef: { current: true },
        clearVarsDraft: (name) => clearVarsDraftCalls.push(name),
        onVariablesChange: (vars) => onVariablesChangeCalls.push(vars),
        setDirty: (v) => setDirtyCalls.push(v),
      });
    });

    const saveFn = useProjectStore.getState()._saveCallbacks.get('ds-vars-DS2');
    await saveFn!();

    expect(setDirtyCalls).toEqual([false]);
    expect(clearVarsDraftCalls).toEqual(['DS2']);
    expect(onVariablesChangeCalls).toEqual([treeA]);

    unmount();
  });
});
