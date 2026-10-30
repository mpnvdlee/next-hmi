import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import DatasourceVariableToolbar from './DatasourceVariableToolbar';

const actions = {
  onToggleLive: vi.fn(),
  onCollapseAll: vi.fn(),
  onExpandAll: vi.fn(),
  onFilterChange: vi.fn(),
  onBrowse: vi.fn(),
  onCheck: vi.fn(),
  onTogglePlc: vi.fn(),
};

describe('DatasourceVariableToolbar', () => {
  it('keeps the Browse PLC label while a review blocks it', () => {
    render(
      <DatasourceVariableToolbar
        state={{
          dsType: 'opcua-client',
          showLive: false,
          filter: '',
          browsing: false,
          browseDisabled: true,
        }}
        actions={actions}
      />,
    );
    expect(screen.getByRole('button', { name: 'Browse PLC' })).toBeDisabled();
  });

  it('turns Browse PLC of an ADS datasource into Stop browsing while it shows the PLC', () => {
    const state = { dsType: 'ads-client', showLive: false, filter: '', browsing: false };
    const { rerender } = render(
      <DatasourceVariableToolbar state={{ ...state, connected: false }} actions={actions} />,
    );
    const browse = screen.getByRole('button', { name: 'Browse PLC' });
    expect(browse).toBeDisabled();
    expect(browse.title).toBe('Connect the datasource to browse its PLC');

    rerender(<DatasourceVariableToolbar state={{ ...state, connected: true }} actions={actions} />);
    fireEvent.click(screen.getByRole('button', { name: 'Browse PLC' }));
    expect(actions.onTogglePlc).toHaveBeenCalledTimes(1);

    // Stopping works even once the link has dropped.
    rerender(
      <DatasourceVariableToolbar
        state={{ ...state, connected: false, plcShown: true }}
        actions={actions}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Browse PLC' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop browsing' }));
    expect(actions.onTogglePlc).toHaveBeenCalledTimes(2);
  });

  it('offers Check against PLC as a compact button, only with something to check', () => {
    const { rerender } = render(
      <DatasourceVariableToolbar
        state={{
          dsType: 'ads-client',
          showLive: false,
          filter: '',
          browsing: false,
          canCheck: true,
        }}
        actions={actions}
      />,
    );
    const check = screen.getByRole('button', { name: 'Check against PLC' });
    expect(check).toBeEnabled();
    expect(check.textContent).toBe('');

    rerender(
      <DatasourceVariableToolbar
        state={{
          dsType: 'ads-client',
          showLive: false,
          filter: '',
          browsing: false,
          canCheck: false,
        }}
        actions={actions}
      />,
    );
    expect(screen.getByRole('button', { name: 'Check against PLC' })).toBeDisabled();
  });

  it('shows no check for an OPC-UA datasource', () => {
    render(
      <DatasourceVariableToolbar
        state={{ dsType: 'opcua-client', showLive: false, filter: '', browsing: false }}
        actions={actions}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Check against PLC' })).toBeNull();
  });
});
