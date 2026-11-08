import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useRepeatEditorScope } from '../../editor/PropertySourceEditor/repeatScopeContext';
import SchemaFieldRow from './index';

// Stands in for the action editors, which read the scope the same way.
vi.mock('../../editor/PropertiesPanel/ActionsInput', () => ({
  default: function Probe() {
    const scope = useRepeatEditorScope();
    return <span>{scope ? `members: ${scope.members?.join(',')}` : 'no scope'}</span>;
  },
}));

describe('SchemaFieldRow actions declared repeatsOver', () => {
  const props = { items: [{ nId: 1, sName: 'Krat' }] };

  it("offers Repeat item over the widget's own item list", () => {
    render(
      <SchemaFieldRow
        schema={{ type: 'actions', label: 'On Select', event: 'onSelect', repeatsOver: 'items' }}
        value={undefined}
        onChange={vi.fn()}
        allProperties={props}
      />,
    );
    expect(screen.getByText('members: nId,sName')).toBeInTheDocument();
  });

  it('offers nothing on an action list that does not declare it', () => {
    render(
      <SchemaFieldRow
        schema={{ type: 'actions', label: 'Actions' }}
        value={undefined}
        onChange={vi.fn()}
        allProperties={props}
      />,
    );
    expect(screen.getByText('no scope')).toBeInTheDocument();
  });
});
