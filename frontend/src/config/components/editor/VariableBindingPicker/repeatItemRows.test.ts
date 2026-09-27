import {
  isPickableRepeatKey,
  repeatPickFits,
  repeatItemProperties,
  repeatPickFromKey,
  repeatPickKey,
  repeatPickLabel,
  repeatPickMembers,
  repeatPickVarType,
} from './repeatItemRows';
import type { RequiredFieldEntry } from '@shared/types/widgetSchema';
import type { StructMember, VarType } from '@shared/types/varType';

const scalarScope = { members: [], writable: true, elementType: 'Float' };
const structScope = { members: ['Name', 'Speed'], writable: true, elementType: 'struct' };

describe('repeat item rows', () => {
  it('round-trips every pick through its row key', () => {
    for (const pick of [
      { field: 'value' as const },
      { field: 'value' as const, member: 'data/0/value' },
      { field: 'index' as const },
    ]) {
      expect(repeatPickFromKey(repeatPickKey(pick))).toEqual(pick);
    }
    expect(repeatPickFromKey('PLC:element')).toBeNull();
  });

  it('labels a pick the way the field shows it', () => {
    expect(repeatPickLabel({ field: 'value', member: 'Speed' })).toBe('Repeat item › Speed');
    expect(repeatPickLabel({})).toBe('Repeat item › Element');
    expect(repeatPickLabel({ field: 'index' })).toBe('Repeat item › Index');
  });

  it('offers the index for reading only', () => {
    const read = { scope: scalarScope, onPick: () => {} };
    const write = { ...read, writeTarget: true };
    expect(Object.keys(repeatItemProperties(read))).toEqual(['element', 'index']);
    expect(Object.keys(repeatItemProperties(write))).toEqual(['element']);
    expect(isPickableRepeatKey(repeatPickKey({ field: 'index' }), read)).toBe(true);
    expect(isPickableRepeatKey(repeatPickKey({ field: 'index' }), write)).toBe(false);
  });

  it('writes a struct element one member at a time, and nothing that is not a variable', () => {
    const write = { scope: structScope, writeTarget: true, onPick: () => {} };
    expect(isPickableRepeatKey(repeatPickKey({ field: 'value' }), write)).toBe(false);
    expect(isPickableRepeatKey(repeatPickKey({ field: 'value', member: 'Speed' }), write)).toBe(
      true,
    );
    const readOnly = { ...write, scope: { ...scalarScope, writable: false } };
    expect(isPickableRepeatKey(repeatPickKey({ field: 'value' }), readOnly)).toBe(false);
  });

  it('lists struct members under the element', () => {
    const props = repeatItemProperties({ scope: structScope, onPick: () => {} });
    expect(props.element.structSchema?.map((n) => n.name)).toEqual(['Name', 'Speed']);
  });
});

describe('repeat item type filter', () => {
  const options = {
    scope: {
      members: ['Name', 'Speed'],
      writable: true,
      elementType: 'struct',
      memberTypes: { Name: 'String', Speed: 'Float' },
    },
    onPick: () => {},
  };
  const fitting = (type: string, write = false) =>
    Object.entries(
      repeatItemProperties(options, (pick) => repeatPickFits(pick, options, { type, write })),
    ).map(([key, p]) => [key, (p.structSchema ?? []).map((n) => n.name)]);

  it('keeps only what the field takes; the element stays for a fitting member', () => {
    expect(fitting('Float')).toEqual([['element', ['Speed']]]);
    expect(fitting('Integer')).toEqual([['index', []]]);
    expect(fitting('Boolean')).toEqual([]);
  });

  it('holds a struct field to the type and access of each required member', () => {
    const struct = (requiredFields: RequiredFieldEntry[]) =>
      repeatPickFits({ field: 'value' }, options, { type: 'struct', requiredFields });
    expect(struct([{ name: 'Speed', type: 'Float', write: true }])).toBe(true);
    expect(struct([{ name: 'Name', type: 'Float' }])).toBe(false);
    const readOnly = { ...options, scope: { ...options.scope, writable: false } };
    expect(
      repeatPickFits({ field: 'value' }, readOnly, {
        type: 'struct',
        requiredFields: [{ name: 'Speed', write: true }],
      }),
    ).toBe(false);
  });

  it('drops the index for a field that writes', () => {
    expect(fitting('Integer', true)).toEqual([]);
  });
});

describe('repeat item over a variable', () => {
  const float: VarType = { kind: 'scalar', base: 'Float', array: false };
  // What RepeatEditorScopeProvider records from the variable metadata.
  const memberInfo: Record<string, StructMember> = {
    Speed: { type: float, writable: false },
    Count: { type: { kind: 'scalar', base: 'Integer', array: false }, writable: true },
    Setpoints: { type: { ...float, array: true }, writable: true },
    Io: { type: { kind: 'struct', name: 'Io', array: false, fields: ['On'] } },
    'Io/On': { type: { kind: 'scalar', base: 'Boolean', array: false } },
  };
  const options = {
    scope: {
      members: ['Speed', 'Count', 'Setpoints', 'Io'],
      writable: true,
      elementType: 'Motor',
      memberTypes: { Speed: 'Float', Count: 'Integer', Setpoints: 'Float' },
      memberInfo,
    },
    onPick: () => {},
  };
  const element = { field: 'value' } as const;
  const member = (name: string) => ({ field: 'value', member: name }) as const;

  it("holds each member to its own access, not the element's", () => {
    const written = [{ name: 'Speed', write: true }];
    expect(repeatPickFits(element, options, { type: 'Motor', requiredFields: written })).toBe(
      false,
    );
    expect(repeatPickFits(member('Speed'), options, { type: 'float', write: true })).toBe(false);
    expect(repeatPickFits(member('Count'), options, { type: 'integer', write: true })).toBe(true);
  });

  it('reads a member whose access the metadata does not state as read-only', () => {
    const unset = {
      ...options,
      scope: {
        ...options.scope,
        memberInfo: { ...memberInfo, Count: { type: memberInfo.Count.type } },
      },
    };
    expect(repeatPickFits(member('Count'), unset, { type: 'integer', write: true })).toBe(false);
  });

  it('judges nested required members', () => {
    const io = (requiredFields: RequiredFieldEntry[]) =>
      repeatPickFits(element, options, { type: 'Motor', requiredFields });
    expect(io([{ name: 'Io', requiredFields: ['On'] }])).toBe(true);
    expect(io([{ name: 'Io', requiredFields: ['Off'] }])).toBe(false);
    expect(repeatPickFits(member('Io'), options, { type: 'Io', requiredFields: ['On'] })).toBe(
      true,
    );
  });

  it('keeps an array member an array', () => {
    expect(repeatPickFits(member('Setpoints'), options, { type: 'float' })).toBe(false);
    expect(repeatPickFits(member('Setpoints'), options, { type: 'float[]' })).toBe(true);
  });

  it('offers nested structs to the Required panel as folders', () => {
    const type = repeatPickVarType(element, options.scope);
    const { fields, folders } = repeatPickMembers(element, type, options.scope);
    expect(Object.keys(fields)).toEqual(['Speed', 'Count', 'Setpoints']);
    expect(fields.Speed.writable).toBe(false);
    expect(folders.Io.children.map((c) => ('display_name' in c ? c.display_name : c.name))).toEqual(
      ['On'],
    );
  });
});

describe('repeat item over a literal list', () => {
  // What RepeatEditorScopeProvider records for `[{ label: 'Low', value: 1 }, …]`.
  const options = {
    scope: {
      members: ['label', 'value', 'unit'],
      writable: false,
      elementType: 'Struct',
      memberTypes: { label: 'String', value: 'Integer' },
    },
    onPick: () => {},
  };
  const member = (name: string) => ({ field: 'value', member: name }) as const;

  it('types each member by its values, exactly', () => {
    expect(repeatPickFits(member('value'), options, { type: 'integer' })).toBe(true);
    expect(repeatPickFits(member('value'), options, { type: 'float' })).toBe(false);
    expect(repeatPickFits(member('label'), options, { type: 'float' })).toBe(false);
    expect(repeatPickFits({ field: 'value' }, options, { type: 'string' })).toBe(false);
  });

  it('trusts a member whose values do not agree on a type', () => {
    expect(repeatPickFits(member('unit'), options, { type: 'float' })).toBe(true);
  });

  it('never fills a writing field', () => {
    expect(repeatPickFits(member('value'), options, { type: 'integer', write: true })).toBe(false);
  });
});
