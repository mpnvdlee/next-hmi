import type {
  PickerFolderEntry,
  PickerVariableEntry,
} from '@config/components/ui/datasourceTreeHelpers';
import type { StructSchemaNode } from '@shared/types/componentProperty';
import { componentPropertyToSchemaField } from '@shared/types/componentProperty';
import { structSatisfies } from '@shared/types/varType';
import {
  declaredVarType,
  formatTypeBadge,
  hasRequiredFields,
  structSchemaLookup,
  structSchemaNodeVarType,
} from './helpers';

describe('formatTypeBadge', () => {
  it('spells simple types canonically, whatever case they were authored in', () => {
    expect(formatTypeBadge('float')).toBe('Float');
    expect(formatTypeBadge(['string', 'integer[]'])).toBe('String, Integer[]');
  });

  it('leaves struct names alone', () => {
    expect(formatTypeBadge('Motor')).toBe('Motor');
    expect(formatTypeBadge('Struct')).toBe('Struct');
  });
});

describe('hasRequiredFields', () => {
  const leaf = (
    display_name: string,
    extra: Partial<PickerVariableEntry> = {},
  ): PickerVariableEntry => ({
    kind: 'variable',
    display_name,
    data_type: 'Float',
    enabled: true,
    writable: true,
    ...extra,
  });
  const folder = (
    name: string,
    children: (PickerFolderEntry | PickerVariableEntry)[],
    is_array = false,
  ): PickerFolderEntry => ({ kind: 'folder', name, is_array, children });

  it('finds no member in a disabled or stale variable — the pool serves neither', () => {
    const motor = folder('Motor', [
      leaf('Speed'),
      leaf('Run', { enabled: false }),
      leaf('Gone', { present_on_server: false }),
    ]);
    expect(hasRequiredFields(motor, ['Speed'])).toBe(true);
    expect(hasRequiredFields(motor, ['Run'])).toBe(false);
    expect(hasRequiredFields(motor, ['Gone'])).toBe(false);
  });

  it('types a struct-array sub-folder as an array', () => {
    const axes = folder('Axes', [folder('[0]', [leaf('Pos')]), folder('[1]', [leaf('Pos')])], true);
    const machine = folder('Machine', [leaf('Speed'), axes]);
    expect(hasRequiredFields(machine, [{ name: 'Axes', type: 'Axis[]' }])).toBe(true);
    expect(hasRequiredFields(machine, [{ name: 'Axes', type: 'Axis' }])).toBe(false);
  });

  it('reads an editor-kind member type as the kind binds', () => {
    const lamp = folder('Lamp', [leaf('Tint', { data_type: 'String' })]);
    expect(hasRequiredFields(lamp, [{ name: 'Tint', type: 'color' }])).toBe(true);
    expect(hasRequiredFields(lamp, [{ name: 'Tint', type: 'integer' }])).toBe(false);
  });
});

describe('struct-schema members', () => {
  const MOTOR: StructSchemaNode[] = [
    { kind: 'variable', name: 'Speed', type: 'Float', write: true },
    { kind: 'variable', name: 'Name', type: 'String' },
    { kind: 'array', name: 'Setpoints', type: 'Float' },
    {
      kind: 'folder',
      name: 'Limits',
      children: [{ kind: 'variable', name: 'Max', type: 'Integer' }],
    },
  ];

  it('types each node the way a variable of it would be typed', () => {
    expect(structSchemaNodeVarType(MOTOR[0])).toEqual({
      kind: 'scalar',
      base: 'Float',
      array: false,
    });
    expect(structSchemaNodeVarType(MOTOR[2])).toEqual({
      kind: 'scalar',
      base: 'Float',
      array: true,
    });
    expect(structSchemaNodeVarType(MOTOR[3])).toMatchObject({ kind: 'struct', fields: ['Max'] });
    expect(declaredVarType('color')).toBeUndefined();
  });

  it('judges required fields by type, access and nesting', () => {
    const lookup = structSchemaLookup(MOTOR);
    expect(structSatisfies([{ name: 'Speed', type: 'Float', write: true }], lookup)).toBe(true);
    expect(structSatisfies([{ name: 'Name', type: 'String', write: true }], lookup)).toBe(false);
    expect(structSatisfies([{ name: 'Setpoints', type: 'Float[]' }], lookup)).toBe(true);
    expect(structSatisfies([{ name: 'Setpoints', type: 'Float' }], lookup)).toBe(false);
    expect(
      structSatisfies(
        [{ name: 'Limits', requiredFields: [{ name: 'Max', type: 'Integer' }] }],
        lookup,
      ),
    ).toBe(true);
    expect(
      structSatisfies(
        [{ name: 'Limits', requiredFields: [{ name: 'Max', type: 'Float' }] }],
        lookup,
      ),
    ).toBe(false);
  });

  it("is satisfied by its own schema's required fields", () => {
    const { requiredFields } = componentPropertyToSchemaField({
      type: 'struct',
      label: 'Motor',
      structSchema: MOTOR,
    });
    expect(requiredFields).toContainEqual({ name: 'Setpoints', type: 'Float[]' });
    expect(structSatisfies(requiredFields!, structSchemaLookup(MOTOR))).toBe(true);
  });
});
