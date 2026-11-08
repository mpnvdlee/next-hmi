import { fireEvent, render, screen } from '@testing-library/react';
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

  it('offers a list-typed export to a field that takes any one of its types', () => {
    const dropdown: ComponentOption[] = [
      {
        id: 'dd',
        name: 'Mode',
        type: 'Dropdown',
        exportedProperties: [
          { key: 'selectedValue', label: 'Selected Value', type: ['string', 'integer'] },
        ],
      },
    ];
    useEditorDomainStore.getState().openWidgetPropPicker(dropdown, () => {}, {
      fieldType: 'integer',
    });
    render(<WidgetPropPicker />);

    expect(screen.getByText('Selected Value')).toBeInTheDocument();
  });

  it('offers the scope’s Inputs beside the Widget Properties, the chosen group first', () => {
    const dropdown: ComponentOption[] = [
      {
        id: 'dd',
        name: 'Keuze',
        type: 'Dropdown',
        exportedProperties: [{ key: 'selectedValue', label: 'Selected Value', type: 'integer' }],
      },
    ];
    const onPickInput = vi.fn();
    const onPickWidget = vi.fn();
    useEditorDomainStore.getState().openWidgetPropPicker(dropdown, onPickWidget, {
      fieldType: 'integer',
      inputs: {
        properties: { doel: { type: 'integer', label: 'Doel', mode: 'value' } },
        onPick: onPickInput,
        first: true,
      },
    });
    render(<WidgetPropPicker />);

    const headers = [...document.querySelectorAll('.editor-binding-item--ds')].map(
      (row) => row.textContent,
    );
    expect(headers[0]).toMatch(/^▼Inputs/);
    expect(headers[1]).toMatch(/^▼Widget Properties/);
    fireEvent.doubleClick(screen.getByText('Doel'));
    expect(onPickInput).toHaveBeenCalledWith('doel');
    expect(onPickWidget).not.toHaveBeenCalled();
  });
});
