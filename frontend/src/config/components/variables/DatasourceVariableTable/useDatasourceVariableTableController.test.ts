import { act, renderHook, waitFor } from '@testing-library/react';
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

const MARKED = {
  node_id: '',
  display_name: 'PLC',
  data_type: null,
  browse_mode: 'marked',
  children: [
    {
      node_id: 'MAIN',
      display_name: 'MAIN',
      data_type: null,
      children: [
        { node_id: 'MAIN.a', display_name: 'a', data_type: 'Double' },
        { node_id: 'MAIN.c', display_name: 'c', data_type: 'Int32', writable: true },
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
    useVariablesDomainStore.setState({
      selectedName: 'plc',
      pendingBrowse: {},
      varsDrafts: {},
      collapsedDrafts: {},
    });
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

  it('shows the PLC variables in the table instead of a full-tree browse, adding a ticked one', async () => {
    mockedApiJson.mockImplementation((url: string) =>
      Promise.resolve(url.endsWith('/check-variables') ? { missing: [], changed: {} } : MARKED),
    );
    const { result } = render();
    await act(() => result.current.handleBrowse());
    expect(result.current.showPlc).toBe(true);
    await waitFor(() => expect(result.current.plcBrowse.nodes).not.toBeNull());

    // Saved folders open collapsed: MAIN counts what the PLC has new in it.
    expect(result.current.rows[0]).toMatchObject({ kind: 'folder', path: 'MAIN', plcNew: 1 });
    act(() => result.current.toggleFolder('MAIN'));

    // Saved a and b, then the PLC's c — a is saved, so it is not offered again.
    const plcRows = result.current.rows.filter((r) => r.kind === 'plc');
    expect(plcRows.map((r) => r.path)).toEqual(['MAIN/c']);
    expect(result.current.plcNewCount).toBe(1);

    act(() => result.current.addFromPlc(['MAIN.c']));
    expect(vars(result.current.tree).map((v) => [v.node_id, v.enabled])).toEqual([
      ['MAIN.a', true],
      ['MAIN.b', true],
      ['MAIN.c', true],
    ]);
    expect(result.current.rows.some((r) => r.kind === 'plc')).toBe(false);
  });

  it('marks, while browsing, the saved variables the PLC lacks or types differently', async () => {
    mockedApiJson.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/check-variables')
          ? { missing: ['MAIN.b'], changed: { 'MAIN.A': 'Float' } }
          : MARKED,
      ),
    );
    const { result } = render();
    expect(result.current.plcMarks).toBeNull();
    act(() => result.current.togglePlc());
    await waitFor(() => expect(result.current.plcMarks).not.toBeNull());
    expect([...result.current.plcMarks!.missing]).toEqual(['main.b']);
    expect([...result.current.plcMarks!.changed]).toEqual([['main.a', 'Float']]);
    // Marks only: the tree is as saved.
    expect(vars(result.current.tree)[1].present_on_server).toBe(false);
    expect(vars(result.current.tree)[0].data_type).toBe('Double');

    act(() => result.current.togglePlc());
    expect(result.current.showPlc).toBe(false);
    expect(result.current.plcMarks).toBeNull();
  });

  it('browses afresh each time it starts', async () => {
    mockedApiJson.mockImplementation((url: string) =>
      Promise.resolve(url.endsWith('/check-variables') ? { missing: [] } : MARKED),
    );
    const { result } = render();
    act(() => result.current.togglePlc());
    await waitFor(() => expect(result.current.plcBrowse.nodes).not.toBeNull());
    act(() => result.current.togglePlc());
    act(() => result.current.togglePlc());
    await waitFor(() => expect(result.current.plcBrowse.nodes).not.toBeNull());
    const browses = mockedApiJson.mock.calls.filter(([url]) => url.endsWith('/browse'));
    expect(browses).toHaveLength(2);
  });

  it('switches the PLC variables off for another datasource, without browsing it', async () => {
    mockedApiJson.mockResolvedValue({
      node_id: '',
      display_name: 'PLC',
      data_type: null,
      children: [],
    });
    const { result, rerender } = renderHook(
      ({ datasource }) =>
        useDatasourceVariableTableController({ datasource, onVariablesChange: vi.fn() }),
      { initialProps: { datasource: ADS } },
    );
    act(() => result.current.togglePlc());
    expect(result.current.showPlc).toBe(true);

    rerender({ datasource: { ...ADS, name: 'other' } });
    expect(result.current.showPlc).toBe(false);
    await act(async () => {});
    expect(mockedApiJson.mock.calls.map(([url]) => url)).not.toContain(
      '/api/datasources/other/browse',
    );
  });

  it('loads the lazy level of an open saved folder to show what it has new', async () => {
    mockedApiJson.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('node_id=MAIN')
          ? {
              node_id: 'MAIN',
              display_name: 'MAIN',
              data_type: null,
              children: [{ node_id: 'MAIN.c', display_name: 'c', data_type: 'Int32' }],
            }
          : {
              node_id: '',
              display_name: 'PLC',
              data_type: null,
              browse_mode: 'lazy',
              children: [
                {
                  node_id: 'MAIN',
                  display_name: 'MAIN',
                  data_type: null,
                  children: [],
                  has_children: true,
                },
              ],
            },
      ),
    );
    const { result } = render();
    act(() => result.current.togglePlc());
    act(() => result.current.toggleFolder('MAIN'));
    await waitFor(() =>
      expect(result.current.rows.filter((r) => r.kind === 'plc').map((r) => r.path)).toEqual([
        'MAIN/c',
      ]),
    );
    // The root, MAIN's level, and the check of the saved variables.
    expect(mockedApiJson).toHaveBeenCalledTimes(3);
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
