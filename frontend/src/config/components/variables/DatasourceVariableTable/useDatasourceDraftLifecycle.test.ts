import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useVariablesDomainStore } from '@config/store/domains/variablesDomainStore';
import { useProjectStore } from '@shared/store/projectStore';
import { useDatasourceDraftLifecycle } from './useDatasourceDraftLifecycle';
import type { DatasourceConfig, TreeNode } from '@shared/types/datasource';

function makeDatasource(overrides?: Partial<DatasourceConfig>): DatasourceConfig {
  return {
    type: 'opcua-client',
    name: 'PLC',
    settings: {
      server_url: '',
      username: '',
      password: '',
      security_policy: 'NoSecurity',
      security_mode: 'SignAndEncrypt',
      client_certificate: '',
      client_private_key: '',
      client_private_key_password: '',
      server_certificate: '',
      reconnect_interval_s: 5,
    },
    variables: [
      {
        kind: 'folder',
        name: 'Folder1',
        children: [{ kind: 'variable', display_name: 'A', data_type: 'Float', enabled: true }],
      },
      { kind: 'variable', display_name: 'B', data_type: 'Float', enabled: true },
    ],
    ...overrides,
  };
}

function renderLifecycle(datasource: DatasourceConfig | null) {
  const setVarsDraft = vi.fn();
  const clearVarsDraft = vi.fn();
  const setCollapsedDraft = vi.fn();
  const rendered = renderHook(
    ({ ds }: { ds: DatasourceConfig | null }) =>
      useDatasourceDraftLifecycle({
        datasource: ds,
        setVarsDraft,
        clearVarsDraft,
        setCollapsedDraft,
      }),
    { initialProps: { ds: datasource } },
  );
  return { ...rendered, setVarsDraft, clearVarsDraft, setCollapsedDraft };
}

describe('useDatasourceDraftLifecycle', () => {
  afterEach(() => {
    useVariablesDomainStore.setState({ propsDrafts: {}, varsDrafts: {}, collapsedDrafts: {} });
    useProjectStore.setState({ dirty: false });
  });

  it('hydrates the tree from datasource.variables when there is no saved draft, and collapses all folders by default', () => {
    const ds = makeDatasource();
    const { result } = renderLifecycle(ds);

    expect(result.current.tree).toEqual(ds.variables);
    expect(result.current.dirty).toBe(false);
    expect(result.current.collapsed).toEqual(new Set(['Folder1']));
  });

  it('hydrates the tree from a saved varsDraft and marks the config dirty (§ draft restore)', () => {
    const ds = makeDatasource();
    const draftTree: TreeNode[] = [
      { kind: 'variable', display_name: 'DraftedVar', data_type: 'Float', enabled: true },
    ];
    useVariablesDomainStore.setState({ varsDrafts: { [ds.name]: draftTree } });

    const { result } = renderLifecycle(ds);

    expect(result.current.tree).toEqual(draftTree);
    expect(result.current.dirty).toBe(true);
    expect(useProjectStore.getState().dirty).toBe(true);
  });

  it('restores collapsed UI state from a saved collapsedDraft instead of the folder-derived default', () => {
    const ds = makeDatasource();
    useVariablesDomainStore.setState({ collapsedDrafts: { [ds.name]: ['SomeOtherFolder'] } });

    const { result } = renderLifecycle(ds);

    expect(result.current.collapsed).toEqual(new Set(['SomeOtherFolder']));
  });

  it('resets to an empty, non-dirty tree when the datasource is cleared', () => {
    const ds = makeDatasource();
    const { result, rerender } = renderLifecycle(ds);
    expect(result.current.tree.length).toBeGreaterThan(0);

    rerender({ ds: null });

    expect(result.current.tree).toEqual([]);
    expect(result.current.dirty).toBe(false);
  });
});
