import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DatasourceListItem } from '@shared/types/datasource';
import DatasourceTree from './index';

function item(name: string, extra: Partial<DatasourceListItem> = {}): DatasourceListItem {
  return {
    name,
    type: 'opcua-client',
    connected: false,
    variable_count: 0,
    enabled_count: 0,
    ...extra,
  };
}

describe('DatasourceTree', () => {
  it('marks a datasource whose server certificate is not trusted', () => {
    render(
      <DatasourceTree
        datasources={[
          item('Line1', { server_certificate_status: 'untrusted' }),
          item('Line2', { server_certificate_status: 'changed' }),
          item('Line3', { server_certificate_status: 'trusted', connected: true }),
          item('Mock', { type: 'static' }),
        ]}
        selectedName={null}
        existingNames={[]}
        onSelect={vi.fn()}
        onAdd={vi.fn()}
        onDelete={vi.fn()}
        onBrowseVariables={vi.fn()}
      />,
    );

    const chips = screen.getAllByText('Not trusted');
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveAttribute('title', 'The server certificate is not trusted yet');
    expect(chips[1]).toHaveAttribute(
      'title',
      'The server certificate changed since it was trusted',
    );
  });
});
