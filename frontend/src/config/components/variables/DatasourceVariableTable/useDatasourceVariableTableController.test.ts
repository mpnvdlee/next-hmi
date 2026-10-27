import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVariablesDomainStore } from '@config/store/domains/variablesDomainStore';
import type { DatasourceConfig, FolderEntry, VariableEntry } from '@shared/types/datasource';
import { apiJson } from '@shared/utils/api';
import { useDatasourceVariableTableController } from './useDatasourceVariableTableController';

vi.mock('@shared/utils/api', () => ({ apiJson: vi.fn(), apiNdjson: vi.fn() }));

const mockedApiJson = vi.mocked(apiJson);

const ADS: DatasourceConfig = {
  type: 'ads-client',
  name: 'plc',
  settings: { host: '127.0.0.1' },
  variables: [
    {
      kind: 'folder',
      name: 'MAIN',
      node_id: 'MAIN',
      children: [
        {
          kind: 'variable',
          node_id: 'MAIN.a',
          display_name: 'a',
          data_type: 'Double',
          enabled: true,
        },
        {
          kind: 'variable',
          node_id: 'MAIN.b',
          display_name: 'b',
          data_type: 'Double',
          enabled: true,
          present_on_server: false,
        },
      ],
    },
  ],
};

function render() {
  return renderHook(() =>
    useDatasourceVariableTableController({ datasource: ADS, onVariablesChange: vi.fn() }),
  );
}

function vars(tree: unknown): VariableEntry[] {
  return (tree as FolderEntry[])[0].children as VariableEntry[];
}

describe('Check against PLC', () => {
  beforeEach(() => {
    mockedApiJson.mockReset();
    useVariablesDomainStore.setState({ selectedName: 'plc', pendingBrowse: {}, varsDrafts: {} });
  });

  afterEach(() => {
    // The hook is still mounted here and subscribes to the store.
    act(() => {
      useVariablesDomainStore.setState({ selectedName: null, pendingBrowse: {}, varsDrafts: {} });
    });
  });

  it('marks missing variables stale, clears the mark on present ones, and offers removal', async () => {
    mockedApiJson.mockResolvedValue({ missing: ['MAIN.a'] });
    const { result } = render();

    await act(() => result.current.checkAgainstPlc());

    expect(mockedApiJson).toHaveBeenCalledWith('/api/datasources/plc/check-variables', {
      method: 'POST',
    });
    const [a, b] = vars(result.current.tree);
    expect(a.present_on_server).toBe(false);
    expect(b.present_on_server).toBeUndefined();
    // Removal is offered, never done: the banner lists the stale ones unticked.
    const pending = useVariablesDomainStore.getState().pendingBrowse.plc;
    expect(pending.diff.removed.map((r) => r.node_id)).toEqual(['MAIN.a']);
    expect(pending.selected.size).toBe(0);
    expect(vars(result.current.tree)).toHaveLength(2);
  });

  it('reports a clean check without touching the tree', async () => {
    mockedApiJson.mockResolvedValue({ missing: [] });
    const { result } = render();
    await act(() => result.current.checkAgainstPlc());

    expect(vars(result.current.tree)[1].present_on_server).toBeUndefined();
    expect(result.current.checkResult).toEqual({
      ok: true,
      message: 'Every saved variable exists on the PLC.',
    });
    expect(useVariablesDomainStore.getState().pendingBrowse.plc).toBeUndefined();
  });

  it('shows why the check failed', async () => {
    mockedApiJson.mockRejectedValue(new Error("Datasource 'plc' is not connected"));
    const { result } = render();
    await act(() => result.current.checkAgainstPlc());
    expect(result.current.checkResult).toEqual({
      ok: false,
      message: "Check against PLC failed: Datasource 'plc' is not connected",
    });
  });

  it('opens the browse dialog instead of a full-tree browse', async () => {
    const { result } = render();
    await act(() => result.current.handleBrowse());
    expect(result.current.adsBrowseOpen).toBe(true);
    expect(mockedApiJson).not.toHaveBeenCalled();
  });

  it('keeps a clean result that un-marked a variable, until dismissed', async () => {
    mockedApiJson.mockResolvedValue({ missing: [] });
    const { result } = render();
    await act(() => result.current.checkAgainstPlc());
    expect(result.current.checkResult?.ok).toBe(true);
    act(() => result.current.dismissCheckResult());
    expect(result.current.checkResult).toBeNull();
  });

  it('clears the result once the tree changes', async () => {
    mockedApiJson.mockResolvedValue({ missing: [] });
    const { result } = render();
    await act(() => result.current.checkAgainstPlc());
    act(() => result.current.updateVar('MAIN/a', 'MAIN.a', { enabled: false }));
    expect(result.current.checkResult).toBeNull();
  });

  it('has nothing to check without saved variables', () => {
    const empty = { ...ADS, variables: [] };
    const { result } = renderHook(() =>
      useDatasourceVariableTableController({ datasource: empty, onVariablesChange: vi.fn() }),
    );
    expect(result.current.canCheck).toBe(false);
    expect(render().result.current.canCheck).toBe(true);
  });
});
