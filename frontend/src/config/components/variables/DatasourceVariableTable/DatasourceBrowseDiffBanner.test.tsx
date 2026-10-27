import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { useVariablesDomainStore } from '@config/store/domains/variablesDomainStore';
import type { VariableEntry } from '@shared/types/datasource';
import DatasourceBrowseDiffBanner from './DatasourceBrowseDiffBanner';
import type { BrowseDiff } from './datasourceBrowseDiff';

function stale(id: string): VariableEntry {
  return { kind: 'variable', node_id: id, display_name: id, data_type: 'Double', enabled: true };
}

const DIFF: BrowseDiff = {
  added: [],
  modified: [],
  silentReactivations: [],
  removed: ['MAIN.a', 'MAIN.b'].map((id) => ({
    kind: 'removed' as const,
    node_id: id,
    path: id.replace('.', '/'),
    entry: stale(id),
  })),
};

describe('DatasourceBrowseDiffBanner', () => {
  afterEach(() => {
    act(() => useVariablesDomainStore.setState({ pendingBrowse: {} }));
  });

  it('words a PLC check as missing variables, with one apply label', () => {
    useVariablesDomainStore.getState().setPendingBrowse('plc', { diff: DIFF });
    render(<DatasourceBrowseDiffBanner dsName="plc" onApply={vi.fn()} plcCheck />);

    expect(screen.getByText('2 saved variables are missing on the PLC')).toBeInTheDocument();
    expect(screen.getByText('Missing on PLC')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply (remove 0, keep 2 stale)' })).toBeDisabled();
    fireEvent.click(screen.getByText('MAIN/a'));
    expect(screen.getByRole('button', { name: 'Apply (remove 1, keep 1 stale)' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Keep all' })).toBeInTheDocument();
  });

  it('keeps the OPC-UA wording', () => {
    useVariablesDomainStore.getState().setPendingBrowse('opc', { diff: DIFF });
    render(<DatasourceBrowseDiffBanner dsName="opc" onApply={vi.fn()} />);
    expect(screen.getByText('2 changes pending')).toBeInTheDocument();
    expect(screen.getByText('Removed from server')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply (mark 2 stale)' })).toBeEnabled();
  });
});
