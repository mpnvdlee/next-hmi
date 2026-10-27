import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CollapsibleSection from '@config/components/ui/CollapsibleSection';
import { PanelScopeContext } from '@config/store/panelExpansionStore';
import AdsConnectionDialog from './AdsConnectionDialog';

vi.mock('@shared/utils/api', () => ({ apiJson: vi.fn() }));

describe('AdsConnectionDialog', () => {
  it('creates the datasource with its name and settings once both are given', async () => {
    const onCreate = vi.fn();
    render(
      <AdsConnectionDialog
        existingNames={['Line1']}
        onCreate={onCreate}
        onBrowseVariables={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const create = screen.getByRole('button', { name: 'Create connection' });
    expect(create).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText('e.g. LinePLC'), { target: { value: 'line1' } });
    fireEvent.change(screen.getByPlaceholderText('192.168.1.10'), {
      target: { value: ' 10.0.0.20 ' },
    });
    expect(screen.getByText('A datasource with this name already exists.')).toBeInTheDocument();
    expect(create).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText('e.g. LinePLC'), { target: { value: 'Line2' } });
    fireEvent.click(create);

    expect(onCreate).toHaveBeenCalledWith(
      'Line2',
      expect.objectContaining({
        host: '10.0.0.20',
        ams_port: 851,
        route_method: 'twincat',
        browse_mode: 'marked',
        browse_attributes: 'OPC.UA.DA',
      }),
    );
    expect(await screen.findByText('Connection created')).toBeInTheDocument();
  });

  it('starts with Advanced collapsed, whatever the properties panel has open', () => {
    render(
      <PanelScopeContext.Provider value="panel">
        <CollapsibleSection title="Advanced">open in the panel</CollapsibleSection>
      </PanelScopeContext.Provider>,
    );
    expect(screen.getByText('open in the panel')).toBeInTheDocument();
    render(
      <AdsConnectionDialog
        existingNames={[]}
        onCreate={vi.fn()}
        onBrowseVariables={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText('Browse Mode')).toBeNull();
  });
});
