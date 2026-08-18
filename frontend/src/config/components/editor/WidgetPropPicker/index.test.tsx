import { render, screen } from '@testing-library/react';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import WidgetPropPicker from './index';
import type { ComponentOption } from '../WidgetOptionsContext';

const structComponentOptions: ComponentOption[] = [
  {
    id: 'comp-1',
    name: 'MyGrid',
    type: 'RecordTable',
    exportedProperties: [
      {
        key: 'selectedRow',
        label: 'Selected Row',
        type: 'Struct',
        structSchema: [
          { name: 'name', type: 'string' },
          { name: 'active', type: 'boolean' },
        ],
      },
    ],
  },
];

describe('WidgetPropPicker', () => {
  afterEach(() => {
    useEditorDomainStore.getState().closeWidgetPropPicker();
  });

  it('excludes a Struct export with no field matching a numeric target', () => {
    useEditorDomainStore
      .getState()
      .openWidgetPropPicker(structComponentOptions, () => {}, { fieldType: 'integer' });
    render(<WidgetPropPicker />);

    expect(screen.queryByText('Selected Row')).not.toBeInTheDocument();
    expect(screen.getByText('No matches.')).toBeInTheDocument();
  });

  it('includes a Struct export when one of its fields matches the target type', () => {
    useEditorDomainStore
      .getState()
      .openWidgetPropPicker(structComponentOptions, () => {}, { fieldType: 'boolean' });
    render(<WidgetPropPicker />);

    expect(screen.getByText('Selected Row')).toBeInTheDocument();
  });
});
