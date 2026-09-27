import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  PickerFolderEntry,
  PickerVariableEntry,
} from '@config/components/ui/datasourceTreeHelpers';
import type { StructSchemaNode } from '@shared/types/componentProperty';
import RightPanel, { type ComponentPropMode, type VarMode } from './RightPanel';

afterEach(cleanup);

function selectedPane(): HTMLElement {
  return document.querySelector('.editor-binding-mid') as HTMLElement;
}

function requiredPane(): HTMLElement {
  return document.querySelector('.editor-binding-requirements') as HTMLElement;
}

function scalarVar(overrides: Partial<PickerVariableEntry> = {}): PickerVariableEntry {
  return {
    kind: 'variable',
    display_name: 'Speed',
    data_type: 'Float',
    enabled: true,
    writable: true,
    _datasource: 'PLC',
    _path: 'Speed',
    ...overrides,
  };
}

describe('RightPanel — var-mode scalar', () => {
  it('shows "Nothing selected" when no variable is bound yet', () => {
    render(
      <RightPanel pickerTitle="Speed" selectedKey={null} varMode={null} componentPropMode={null} />,
    );
    expect(screen.getByText('Nothing selected')).toBeInTheDocument();
  });

  it('renders the selected scalar variable name, type, and datasource path badge', () => {
    const mode: VarMode = {
      schemaField: { type: 'Float', requiredFields: undefined },
      selectedVar: scalarVar(),
      selectedParentVar: null,
      rawSelectedFolder: null,
      scalarIsValid: true,
      isStruct: false,
      pendingSelection: false,
      strictFolderSelectable: true,
    };
    render(
      <RightPanel
        pickerTitle="Speed"
        selectedKey="PLC:Speed"
        varMode={mode}
        componentPropMode={null}
      />,
    );
    const pane = within(selectedPane());
    expect(pane.getByText('Speed')).toBeInTheDocument();
    expect(pane.getByText(/Float/)).toBeInTheDocument();
    expect(pane.getByText('PLC')).toBeInTheDocument();
  });

  it('renders an array-element preview with its own element index label', () => {
    const parent = scalarVar({
      display_name: 'Setpoints',
      _path: 'Setpoints',
      is_array: true,
      array_length: 4,
    });
    const mode: VarMode = {
      schemaField: { type: 'Float' },
      selectedVar: null,
      selectedParentVar: parent,
      selectedElementIndex: 2,
      rawSelectedFolder: null,
      scalarIsValid: true,
      isStruct: false,
      pendingSelection: false,
      strictFolderSelectable: true,
    };
    render(
      <RightPanel
        pickerTitle="Setpoint"
        selectedKey="PLC:Setpoints[2]"
        varMode={mode}
        componentPropMode={null}
      />,
    );
    expect(within(selectedPane()).getByText('Setpoints[2]')).toBeInTheDocument();
  });
});

describe('RightPanel — var-mode struct (nested binding preview)', () => {
  it('renders required fields and marks a matched child variable', () => {
    const folder: PickerFolderEntry = {
      kind: 'folder',
      name: 'Motor',
      _path: 'Motor',
      _datasource: 'PLC',
      children: [scalarVar({ display_name: 'Speed', _path: 'Motor/Speed' })],
    };
    const mode: VarMode = {
      schemaField: {
        label: 'Motor binding',
        requiredFields: ['Speed', { name: 'Torque', type: 'Float' }],
      },
      selectedVar: null,
      selectedParentVar: null,
      rawSelectedFolder: folder,
      scalarIsValid: null,
      isStruct: true,
      pendingSelection: false,
      strictFolderSelectable: true,
    };
    render(
      <RightPanel
        pickerTitle="Motor"
        selectedKey="PLC:Motor"
        varMode={mode}
        componentPropMode={null}
      />,
    );
    const required = within(requiredPane());
    expect(screen.getByText('Motor binding')).toBeInTheDocument();
    expect(required.getByText('Speed')).toBeInTheDocument();
    expect(required.getByText('Torque')).toBeInTheDocument();
    // Speed is present under the selected folder (matched); Torque is not (mismatch).
    expect(required.getAllByText('✗').length).toBeGreaterThan(0);
    expect(required.getAllByText('✓').length).toBeGreaterThan(0);
  });

  it('recurses into nested required sub-fields for a struct-of-struct folder', () => {
    const innerFolder: PickerFolderEntry = {
      kind: 'folder',
      name: 'Limits',
      _path: 'Motor/Limits',
      children: [scalarVar({ display_name: 'Max', _path: 'Motor/Limits/Max' })],
    };
    const folder: PickerFolderEntry = {
      kind: 'folder',
      name: 'Motor',
      _path: 'Motor',
      children: [innerFolder],
    };
    const mode: VarMode = {
      schemaField: {
        requiredFields: [{ name: 'Limits', requiredFields: [{ name: 'Max', type: 'Float' }] }],
      },
      selectedVar: null,
      selectedParentVar: null,
      rawSelectedFolder: folder,
      scalarIsValid: null,
      isStruct: true,
      pendingSelection: false,
      strictFolderSelectable: true,
    };
    render(
      <RightPanel
        pickerTitle="Motor"
        selectedKey="PLC:Motor"
        varMode={mode}
        componentPropMode={null}
      />,
    );
    const required = within(requiredPane());
    expect(required.getByText('Limits')).toBeInTheDocument();
    expect(required.getByText('Max')).toBeInTheDocument();
    // The nested field matched, since Motor/Limits/Max exists under the selected folder.
    expect(required.getAllByText('✓').length).toBeGreaterThan(0);
  });
});

describe('RightPanel — component-prop mode', () => {
  it('shows the required scalar type and "Nothing selected" before a pick', () => {
    const mode: ComponentPropMode = {
      fieldType: 'Float',
      isStructTarget: false,
      typeIsOk: null,
      selectedItem: null,
    };
    render(
      <RightPanel pickerTitle="Value" selectedKey={null} varMode={null} componentPropMode={mode} />,
    );
    expect(within(requiredPane()).getByText('Value')).toBeInTheDocument();
    expect(screen.getByText('Nothing selected')).toBeInTheDocument();
  });

  it('renders a nested struct schema preview for the selected property', () => {
    const structNodes: StructSchemaNode[] = [
      { kind: 'variable', name: 'X', type: 'Float' },
      {
        kind: 'folder',
        name: 'Nested',
        children: [{ kind: 'variable', name: 'Y', type: 'Float' }],
      },
    ];
    const mode: ComponentPropMode = {
      isStructTarget: true,
      typeIsOk: true,
      requiredFields: ['X'],
      requiredNamesSet: new Set(['X']),
      selectedItem: {
        propKey: 'position',
        propSchema: { type: 'struct', label: 'Position', structSchema: structNodes },
        node: null,
        structNodes,
        displayLabel: 'position',
      },
    };
    render(
      <RightPanel
        pickerTitle="Position"
        selectedKey="position"
        varMode={null}
        componentPropMode={mode}
      />,
    );
    const selected = within(selectedPane());
    expect(selected.getByText('X')).toBeInTheDocument();
    expect(selected.getByText('Nested')).toBeInTheDocument();
    expect(selected.getByText('Y')).toBeInTheDocument();
    // X is required and present -> matched (not marked unused); Nested is not
    // in requiredFields -> unused.
    const nestedRow = selected.getByText('Nested').closest('div');
    expect(nestedRow?.className).toContain('editor-binding-char-row--unused');
  });
});

describe('RightPanel — the verdict beside Required', () => {
  function verdict(): string | null {
    const header = requiredPane().querySelector('.editor-binding-req-row');
    return header?.querySelector('.editor-binding-char-row__match-slot')?.textContent ?? null;
  }

  function varMode(overrides: Partial<VarMode>): VarMode {
    return {
      schemaField: { type: 'Float' },
      selectedVar: null,
      selectedParentVar: null,
      rawSelectedFolder: null,
      scalarIsValid: null,
      isStruct: false,
      pendingSelection: false,
      strictFolderSelectable: false,
      ...overrides,
    };
  }

  const STRUCT_FIELD = { label: 'Motor', type: 'struct', requiredFields: ['Speed'] };

  it('shows none while nothing is selected', () => {
    render(
      <RightPanel
        pickerTitle="Speed"
        selectedKey={null}
        varMode={varMode({})}
        componentPropMode={null}
      />,
    );
    expect(verdict()).toBeNull();
  });

  it('marks a binding that no longer exists, once its datasource has loaded', () => {
    render(
      <RightPanel
        pickerTitle="Speed"
        selectedKey="PLC:Gone"
        varMode={varMode({ scalarIsValid: false })}
        componentPropMode={null}
      />,
    );
    expect(verdict()).toBe('✗');
    expect(within(selectedPane()).getByText('Not found')).toBeInTheDocument();
  });

  it('shows the struct header verdict for a matching folder', () => {
    const folder: PickerFolderEntry = {
      kind: 'folder',
      name: 'Motor',
      _path: 'Motor',
      _datasource: 'PLC',
      children: [scalarVar({ display_name: 'Speed', _path: 'Motor/Speed' })],
    };
    render(
      <RightPanel
        pickerTitle="Motor"
        selectedKey="PLC:Motor"
        varMode={varMode({
          schemaField: STRUCT_FIELD,
          isStruct: true,
          rawSelectedFolder: folder,
          strictFolderSelectable: true,
        })}
        componentPropMode={null}
      />,
    );
    expect(verdict()).toBe('✓');
  });

  it('marks the struct header and every field when a scalar is picked for a struct', () => {
    render(
      <RightPanel
        pickerTitle="Motor"
        selectedKey="PLC:Speed"
        varMode={varMode({ schemaField: STRUCT_FIELD, isStruct: true, selectedVar: scalarVar() })}
        componentPropMode={null}
      />,
    );
    expect(verdict()).toBe('✗');
    expect(within(requiredPane()).getAllByText('✗')).toHaveLength(2);
  });

  it('judges a Repeat item element by its members', () => {
    render(
      <RightPanel
        pickerTitle="Motor"
        selectedKey="#repeat:element"
        varMode={varMode({
          schemaField: STRUCT_FIELD,
          isStruct: true,
          repeatSelected: {
            label: 'Repeat item › Element',
            writable: true,
            fields: { Speed: scalarVar({ display_name: 'Speed' }) },
          },
        })}
        componentPropMode={null}
      />,
    );
    expect(verdict()).toBe('✓');
  });

  it('shows none for a struct selection whose datasource is still loading', () => {
    render(
      <RightPanel
        pickerTitle="Motor"
        selectedKey="PLC:Motor"
        varMode={varMode({ schemaField: STRUCT_FIELD, isStruct: true, pendingSelection: true })}
        componentPropMode={null}
      />,
    );
    expect(verdict()).toBeNull();
  });

  it('judges every field of a struct component property, even for a leaf pick', () => {
    const mode: ComponentPropMode = {
      fieldType: 'struct',
      requiredFields: ['Speed'],
      isStructTarget: true,
      typeIsOk: false,
      selectedItem: {
        propKey: 'label',
        propSchema: { type: 'string', label: 'Label' },
        node: null,
        structNodes: null,
        displayLabel: 'Label',
      },
    };
    render(
      <RightPanel
        pickerTitle="Motor"
        selectedKey="label"
        varMode={null}
        componentPropMode={mode}
      />,
    );
    expect(within(requiredPane()).getAllByText('✗')).toHaveLength(2);
  });
});
