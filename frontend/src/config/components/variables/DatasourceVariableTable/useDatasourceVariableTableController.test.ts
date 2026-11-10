import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useProjectStore } from '@shared/store/projectStore';
import { useVariablesDomainStore } from '@config/store/domains/variablesDomainStore';
import type { DatasourceConfig } from '@shared/types/datasource';
import { useDatasourceVariableTableController } from './useDatasourceVariableTableController';

const datasource = {
  name: 'PLC',
  type: 'opcua-client',
  settings: { url: 'opc.tcp://plc:4840' },
  variables: [],
} as unknown as DatasourceConfig;

describe('useDatasourceVariableTableController browse', () => {
  afterEach(() => {
    useProjectStore.getState().unregisterSave('ds-props-PLC');
    useVariablesDomainStore.setState({ propsDrafts: {}, browseRequestName: null });
  });

  it('saves unsaved connection settings first, then waits for the reconnect', async () => {
    const save = vi.fn(async () => {
      useVariablesDomainStore.getState().clearPropsDraft('PLC');
    });
    useProjectStore.getState().registerSave('ds-props-PLC', save);
    useVariablesDomainStore.setState({ propsDrafts: { PLC: { browse_root_node: 'ns=4;s=gPlc' } } });

    const { result } = renderHook(() =>
      useDatasourceVariableTableController({ datasource, onVariablesChange: () => {} }),
    );
    await act(() => result.current.handleBrowse());

    expect(save).toHaveBeenCalledOnce();
    expect(useVariablesDomainStore.getState().browseRequestName).toBe('PLC');
  });
});
