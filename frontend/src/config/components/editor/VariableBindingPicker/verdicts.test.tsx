/**
 * The ✓/✗ beside "Required" in every binding drawer: none while nothing is
 * selected, and a verdict for anything that is — across the field types
 * callers pass and the kinds of thing a user can select. A ✗ also disables
 * Confirm.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiJson } from '@shared/utils/api';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import type { RequiredFieldEntry } from '@shared/types/widgetSchema';
import type { ComponentOption } from '../WidgetOptionsContext';
import { widgetPropRowKey } from '../WidgetPropPicker/rowKey';
import WidgetPropPicker from '../WidgetPropPicker';
import VariableBindingPicker from './index';

vi.mock('@shared/utils/api', () => ({ apiJson: vi.fn() }));

const mockedApiJson = vi.mocked(apiJson);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useEditorDomainStore.getState().closeBindingPicker();
  useEditorDomainStore.getState().closeWidgetPropPicker();
});

const leaf = (display_name: string, data_type: string, writable = true) => ({
  display_name,
  data_type,
  enabled: true,
  writable,
});
const motor = (name: string, speedWritable = true) => ({
  kind: 'folder',
  name,
  children: [leaf('Speed', 'Float', speedWritable), leaf('Name', 'String')],
});

const PLC_VARIABLES = [
  leaf('Speed', 'Float'),
  leaf('SpeedRO', 'Float', false),
  leaf('Run', 'Boolean'),
  leaf('Count', 'Integer'),
  leaf('Label', 'String'),
  { ...leaf('Setpoints', 'Float'), is_array: true, array_length: 3 },
  motor('Motor'),
  motor('MotorRO', false),
  { kind: 'folder', name: 'Pump', children: [leaf('Name', 'String')] },
  {
    kind: 'folder',
    name: 'Fan',
    children: [leaf('Speed', 'Float'), { ...leaf('Run', 'Boolean'), enabled: false }],
  },
  { kind: 'folder', name: 'Motors', is_array: true, children: [motor('[0]'), motor('[1]')] },
];

function verdict(): string | null {
  const header = document.querySelector('.editor-binding-requirements .editor-binding-req-row');
  return header?.querySelector('.editor-binding-char-row__match-slot')?.textContent ?? null;
}

function confirmDisabled(): boolean {
  return (screen.getByRole('button', { name: /Confirm/ }) as HTMLButtonElement).disabled;
}

function fieldVerdicts(): string[] {
  return [...document.querySelectorAll('.editor-binding-children-group .editor-binding-req-row')]
    .filter((row) => !row.closest('.editor-binding-mid'))
    .map((row) => row.querySelector('.editor-binding-char-row__match-slot')?.textContent ?? '');
}

const SPEED: RequiredFieldEntry[] = [{ name: 'Speed', type: 'Float' }];
const SPEED_WRITE: RequiredFieldEntry[] = [{ name: 'Speed', type: 'Float', write: true }];
const REPEATER_ITEMS = [
  'item-list',
  'struct[]',
  'string[]',
  'integer[]',
  'float[]',
  'boolean[]',
  'datetime[]',
];

type Filter = {
  type?: string | string[];
  write?: boolean;
  requiredFields?: RequiredFieldEntry[];
};

// [field, selected key, expected verdict]
const VARIABLE_CASES: [string, Filter | undefined, string, string][] = [
  ['Float', { type: 'Float' }, 'PLC:Speed', '✓'],
  ['Float', { type: 'Float' }, 'PLC:SpeedRO', '✓'],
  ['Float', { type: 'Float' }, 'PLC:Run', '✗'],
  ['Float', { type: 'Float' }, 'PLC:Setpoints', '✗'],
  ['Float', { type: 'Float' }, 'PLC:Setpoints[1]', '✓'],
  ['Float', { type: 'Float' }, 'PLC:Setpoints[#]', '✓'],
  ['Float', { type: 'Float' }, 'PLC:Motor', '✗'],
  ['Float', { type: 'Float' }, 'PLC:Gone', '✗'],
  ['writable Float', { type: 'Float', write: true }, 'PLC:Speed', '✓'],
  ['writable Float', { type: 'Float', write: true }, 'PLC:SpeedRO', '✗'],
  ['Float', { type: 'Float' }, 'PLC:Count', '✗'],
  ['Integer', { type: 'Integer' }, 'PLC:Speed', '✗'],
  ['Color', { type: 'Color' }, 'PLC:Label', '✓'],
  ['Color', { type: 'Color' }, 'PLC:Speed', '✗'],
  ['Boolean', { type: 'Boolean' }, 'PLC:Run', '✓'],
  ['Boolean', { type: 'Boolean' }, 'PLC:Speed', '✗'],
  ['Float[]', { type: 'float[]' }, 'PLC:Setpoints', '✓'],
  ['Float[]', { type: 'float[]' }, 'PLC:Setpoints[1]', '✗'],
  ['struct', { type: 'Motor', requiredFields: SPEED }, 'PLC:Motor', '✓'],
  ['struct', { type: 'Motor', requiredFields: SPEED }, 'PLC:Motors/[1]', '✓'],
  ['struct', { type: 'Motor', requiredFields: SPEED }, 'PLC:Pump', '✗'],
  ['struct', { type: 'Fan', requiredFields: SPEED }, 'PLC:Fan', '✓'],
  ['struct', { type: 'Fan', requiredFields: ['Speed', 'Run'] }, 'PLC:Fan', '✗'],
  ['struct', { type: 'Motor', requiredFields: SPEED }, 'PLC:Speed', '✗'],
  ['struct', { type: 'Motor', requiredFields: SPEED }, 'PLC:Motors', '✗'],
  ['struct', { type: 'Motor', requiredFields: SPEED }, 'PLC:Gone', '✗'],
  ['writable struct', { type: 'Motor', requiredFields: SPEED_WRITE }, 'PLC:Motor', '✓'],
  ['writable struct', { type: 'Motor', requiredFields: SPEED_WRITE }, 'PLC:MotorRO', '✗'],
  [
    'typed struct',
    { type: 'Motor', requiredFields: [{ name: 'Name', type: 'Float' }] },
    'PLC:Motor',
    '✗',
  ],
  ['struct[]', { type: 'Motor[]', requiredFields: SPEED }, 'PLC:Motors', '✓'],
  ['struct[]', { type: 'Motor[]', requiredFields: SPEED }, 'PLC:Motor', '✗'],
  ['untyped struct', { type: 'struct' }, 'PLC:Motor', '✓'],
  ['untyped struct', { type: 'struct' }, 'PLC:Speed', '✗'],
  ['Repeater items', { type: REPEATER_ITEMS }, 'PLC:Motors', '✓'],
  ['Repeater items', { type: REPEATER_ITEMS }, 'PLC:Setpoints', '✓'],
  ['Repeater items', { type: REPEATER_ITEMS }, 'PLC:Speed', '✗'],
  ['Repeater items', { type: REPEATER_ITEMS }, 'PLC:Motor', '✗'],
  ['any type', undefined, 'PLC:Speed', '✓'],
  ['any type', undefined, 'PLC:Gone', '✗'],
];

function bindingOf(key: string) {
  const m = key.match(/^(.*)\[(\d+)\]$/);
  if (m) return { path: m[1], index: Number(m[2]) };
  if (key.endsWith('[#]')) return { path: key.slice(0, -3), repeatIndex: true };
  return { path: key };
}

describe('variable picker verdicts', () => {
  function open(filter: Filter | undefined, key: string | null) {
    mockedApiJson.mockImplementation(async (url: string) =>
      url === '/api/datasources'
        ? ([{ name: 'PLC', type: 'static' }] as never)
        : ({ variables: PLC_VARIABLES } as never),
    );
    useEditorDomainStore.getState().openBindingPicker('', 'field', {
      filter,
      currentBinding: key ? bindingOf(key) : undefined,
      onPick: vi.fn(),
    });
    render(<VariableBindingPicker />);
  }

  it('shows none while nothing is selected', async () => {
    open({ type: 'Motor', requiredFields: SPEED }, null);
    await waitFor(() => expect(mockedApiJson).toHaveBeenCalled());
    expect(verdict()).toBeNull();
    expect(fieldVerdicts()).toEqual(['']);
  });

  it.each(VARIABLE_CASES)('%s field, %s selected: %s', async (_field, filter, key, expected) => {
    open(filter, key);
    await waitFor(() => expect(verdict()).toBe(expected));
    expect(confirmDisabled()).toBe(expected === '✗');
  });

  it('keeps a selection confirmable while its datasource is still loading', async () => {
    mockedApiJson.mockImplementation((url: string) =>
      url === '/api/datasources'
        ? Promise.resolve([{ name: 'PLC', type: 'static' }] as never)
        : new Promise(() => {}),
    );
    useEditorDomainStore.getState().openBindingPicker('', 'field', {
      filter: { type: 'Float' },
      currentBinding: { path: 'PLC:Speed' },
      onPick: vi.fn(),
    });
    render(<VariableBindingPicker />);
    await waitFor(() => expect(mockedApiJson).toHaveBeenCalledTimes(2));
    expect(verdict()).toBeNull();
    expect(confirmDisabled()).toBe(false);
  });

  it('will not confirm a mismatch with Enter either', async () => {
    const onPick = vi.fn();
    mockedApiJson.mockImplementation(async (url: string) =>
      url === '/api/datasources'
        ? ([{ name: 'PLC', type: 'static' }] as never)
        : ({ variables: [leaf('Label', 'String')] } as never),
    );
    useEditorDomainStore.getState().openBindingPicker('', 'field', {
      filter: { type: 'Float' },
      onPick,
    });
    render(<VariableBindingPicker />);
    await waitFor(() => expect(mockedApiJson).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('checkbox', { name: /Show all/ }));
    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'label' } });
    await waitFor(() => {
      expect(document.querySelector('.editor-binding-list > div')).toHaveStyle({ height: '52px' });
    });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onPick).not.toHaveBeenCalled();
  });

  it('confirms the first result the field takes with Enter, past a mismatch above it', async () => {
    const onPick = vi.fn();
    mockedApiJson.mockImplementation(async (url: string) =>
      url === '/api/datasources'
        ? ([{ name: 'PLC', type: 'static' }] as never)
        : ({ variables: [leaf('Label', 'String'), leaf('Level', 'Float')] } as never),
    );
    useEditorDomainStore.getState().openBindingPicker('', 'field', {
      filter: { type: 'Float' },
      onPick,
    });
    render(<VariableBindingPicker />);
    await waitFor(() => expect(mockedApiJson).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('checkbox', { name: /Show all/ }));
    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'l' } });
    await waitFor(() => {
      expect(document.querySelector('.editor-binding-list > div')).toHaveStyle({ height: '78px' });
    });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith({ path: 'PLC:Level' }, expect.anything());
  });

  it('lists no variable of unknown access for a writing field', async () => {
    mockedApiJson.mockImplementation(async (url: string) =>
      url === '/api/datasources'
        ? ([{ name: 'PLC', type: 'static' }] as never)
        : ({
            variables: [
              { display_name: 'Speed', data_type: 'Float', enabled: true },
              leaf('Setpoint', 'Float'),
            ],
          } as never),
    );
    useEditorDomainStore.getState().openBindingPicker('', 'field', {
      filter: { type: 'Float', write: true },
      onPick: vi.fn(),
    });
    render(<VariableBindingPicker />);
    await waitFor(() => expect(mockedApiJson).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'PLC' } });
    // The datasource row and Setpoint; Speed states no access, so it is read-only.
    await waitFor(() => {
      expect(document.querySelector('.editor-binding-list > div')).toHaveStyle({ height: '52px' });
    });
  });

  it('judges each struct field too, not only the header', async () => {
    open({ type: 'Motor', requiredFields: SPEED }, 'PLC:Speed');
    await waitFor(() => expect(verdict()).toBe('✗'));
    expect(fieldVerdicts()).toEqual(['✗']);
  });
});

describe('Repeat item verdicts', () => {
  const SCOPE = {
    members: ['Name'],
    writable: true,
    elementType: 'struct',
    memberTypes: { Name: 'String' },
  };

  it('will not confirm a Repeat item row the field refuses', () => {
    mockedApiJson.mockResolvedValue([] as never);
    const onPick = vi.fn();
    useEditorDomainStore.getState().openBindingPicker('', 'fill', {
      filter: { type: 'Color' },
      repeatItem: { scope: SCOPE, current: { field: 'index' }, onPick },
    });
    render(<VariableBindingPicker />);
    expect(verdict()).toBe('✗');
    expect(confirmDisabled()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Confirm/ }));
    expect(onPick).not.toHaveBeenCalled();
  });

  it('confirms one the field takes', () => {
    mockedApiJson.mockResolvedValue([] as never);
    const onPick = vi.fn();
    useEditorDomainStore.getState().openBindingPicker('', 'fill', {
      filter: { type: 'Color' },
      repeatItem: { scope: SCOPE, current: { field: 'value', member: 'Name' }, onPick },
    });
    render(<VariableBindingPicker />);
    expect(verdict()).toBe('✓');
    fireEvent.click(screen.getByRole('button', { name: /Confirm/ }));
    expect(onPick).toHaveBeenCalledWith({ field: 'value', member: 'Name' });
  });
});

describe('component input property verdicts', () => {
  const PROPERTIES = {
    speed: { type: 'float', label: 'Speed' },
    setpoint: { type: 'float', label: 'Setpoint', write: true },
    count: { type: 'integer', label: 'Count' },
    mode: { type: 'select', optionType: 'integer' as const, label: 'Mode' },
    icon: { type: 'icon', label: 'Icon' },
    label: { type: 'string', label: 'Label' },
    motor: {
      type: 'struct',
      label: 'Motor',
      structSchema: [
        { kind: 'variable' as const, name: 'Speed', type: 'float' },
        { kind: 'variable' as const, name: 'Target', type: 'float', write: true },
        { kind: 'array' as const, name: 'Setpoints', type: 'Float' },
      ],
    },
    pump: {
      type: 'struct',
      label: 'Pump',
      structSchema: [{ kind: 'variable' as const, name: 'Name', type: 'string' }],
    },
  };

  const CASES: [
    string,
    string | string[] | undefined,
    RequiredFieldEntry[] | undefined,
    string,
    string | null,
    boolean?,
  ][] = [
    ['Float', 'float', undefined, '', null],
    ['Float', 'float', undefined, 'count', '✗'],
    ['writable Float', 'float', undefined, 'speed', '✗', true],
    ['writable Float', 'float', undefined, 'setpoint', '✓', true],
    ['writable Float', 'float', undefined, 'motor/Speed', '✗', true],
    ['writable Float', 'float', undefined, 'motor/Target', '✓', true],
    ['writable, any type', undefined, undefined, 'speed', '✗', true],
    ['writable, any type', undefined, undefined, 'setpoint', '✓', true],
    ['Integer', 'integer', undefined, 'speed', '✗'],
    ['Integer', 'integer', undefined, 'mode', '✓'],
    ['String', 'string', undefined, 'mode', '✗'],
    ['Icon', 'icon', undefined, 'icon', '✓'],
    ['Icon', 'icon', undefined, 'label', '✓'],
    ['String', 'string', undefined, 'icon', '✗'],
    ['Float[]', 'float[]', undefined, 'motor/Setpoints', '✓'],
    ['Float', 'float', undefined, 'motor/Setpoints', '✗'],
    ['struct', 'struct', [{ name: 'Setpoints', type: 'Float[]' }], 'motor', '✓'],
    ['struct', 'struct', [{ name: 'Setpoints', type: 'Float' }], 'motor', '✗'],
    ['Float', 'float', undefined, 'speed', '✓'],
    ['Float', 'float', undefined, 'label', '✗'],
    ['Float', 'float', undefined, 'motor', '✗'],
    ['Float', 'float', undefined, 'motor/Speed', '✓'],
    ['Float', 'float', undefined, 'gone', '✗'],
    ['struct', 'struct', [{ name: 'Speed', type: 'float' }], 'motor', '✓'],
    ['struct', 'struct', [{ name: 'Speed', type: 'float' }], 'pump', '✗'],
    ['struct', 'struct', [{ name: 'Speed', type: 'float' }], 'speed', '✗'],
    ['any type', undefined, undefined, 'label', '✓'],
  ];

  it.each(CASES)(
    '%s field, "%s" selected',
    (_f, fieldType, requiredFields, key, expected, write) => {
      useEditorDomainStore.getState().openBindingPicker('', '$componentProp', {
        componentPropSource: {
          properties: PROPERTIES,
          fieldType,
          requiredFields,
          write,
          onPick: vi.fn(),
          currentKey: key || undefined,
        },
      });
      render(<VariableBindingPicker />);
      expect(verdict()).toBe(expected);
      expect(confirmDisabled()).toBe(expected !== '✓');
      if (requiredFields && key) expect(fieldVerdicts()).not.toContain('');
    },
  );
  it('says why a property of the right type is refused', () => {
    useEditorDomainStore.getState().openBindingPicker('', '$componentProp', {
      componentPropSource: {
        properties: PROPERTIES,
        fieldType: 'float',
        write: true,
        onPick: vi.fn(),
        currentKey: 'speed',
      },
    });
    render(<VariableBindingPicker />);
    expect(screen.getByText('Not declared writable')).toBeInTheDocument();
  });
});

describe('widget property verdicts', () => {
  const COMPONENTS: ComponentOption[] = [
    {
      id: 'in',
      name: 'Input',
      type: 'NumberInput',
      exportedProperties: [
        { key: 'value', label: 'Value', type: 'float' },
        { key: 'count', label: 'Count', type: 'Integer' },
        { key: 'text', label: 'Text', type: 'string' },
        { key: 'untyped', label: 'Untyped' },
        {
          key: 'row',
          label: 'Row',
          type: 'Struct',
          structSchema: [{ name: 'Speed', type: 'float' }],
        },
      ],
    },
  ];

  const CASES: [
    string,
    string | undefined,
    RequiredFieldEntry[] | undefined,
    string | undefined,
    string | null,
  ][] = [
    ['Float', 'float', undefined, undefined, null],
    ['Float', 'float', undefined, widgetPropRowKey('in', 'value'), '✓'],
    ['Float', 'float', undefined, widgetPropRowKey('in', 'count'), '✗'],
    ['Integer', 'integer', undefined, widgetPropRowKey('in', 'value'), '✗'],
    ['String', 'string', undefined, widgetPropRowKey('in', 'untyped'), '✓'],
    ['Float', 'float', undefined, widgetPropRowKey('in', 'untyped'), '✗'],
    ['Float', 'float', undefined, widgetPropRowKey('in', 'text'), '✗'],
    ['Float', 'float', undefined, widgetPropRowKey('in', 'row', 'Speed'), '✓'],
    ['Float', 'float', undefined, widgetPropRowKey('gone', 'value'), '✗'],
    ['struct', 'struct', [{ name: 'Speed', type: 'float' }], widgetPropRowKey('in', 'row'), '✓'],
    ['struct', 'struct', [{ name: 'Speed', type: 'float' }], widgetPropRowKey('in', 'text'), '✗'],
    ['any type', undefined, undefined, widgetPropRowKey('in', 'text'), '✓'],
  ];

  it.each(CASES)('%s field', (_f, fieldType, requiredFields, currentKey, expected) => {
    useEditorDomainStore
      .getState()
      .openWidgetPropPicker(COMPONENTS, () => {}, { fieldType, requiredFields, currentKey });
    render(<WidgetPropPicker />);
    expect(verdict()).toBe(expected);
    expect(confirmDisabled()).toBe(expected !== '✓');
    if (requiredFields && currentKey) expect(fieldVerdicts()).not.toContain('');
  });

  it('will not pick a mismatch on double-click either', () => {
    const onPick = vi.fn();
    useEditorDomainStore.getState().openWidgetPropPicker(COMPONENTS, onPick, {
      fieldType: 'float',
    });
    render(<WidgetPropPicker />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Show all/ }));
    fireEvent.doubleClick(screen.getByText('Text'));
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.doubleClick(screen.getByText('Value'));
    expect(onPick).toHaveBeenCalledWith('in', 'value', undefined);
  });

  it('refuses a writing field an export, which never declares itself writable', () => {
    useEditorDomainStore.getState().openWidgetPropPicker(COMPONENTS, () => {}, {
      write: true,
      currentKey: widgetPropRowKey('in', 'value'),
    });
    render(<WidgetPropPicker />);
    expect(verdict()).toBe('✗');
    expect(screen.getByText('Not declared writable')).toBeInTheDocument();
  });
});
