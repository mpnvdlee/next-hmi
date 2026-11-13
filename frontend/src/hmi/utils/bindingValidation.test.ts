import {
  aggregateBindingStatus,
  checkBindingSpec,
  extractBindingSpecs,
  createBindingStatusSelector,
  type BindingSpec,
  type BindingStoreSlice,
} from './bindingValidation';
import type { VarMeta } from '../store/variableStore';
import { elementMemberValues } from './repeatItemResolution';
import type { EvaluationContext, ResolvedValue } from './propertySourceEval';
import type { AcceptType, VarType } from '@shared/types/varType';

function slice(overrides: Partial<BindingStoreSlice> = {}): BindingStoreSlice {
  return {
    values: {},
    varMeta: {},
    metadataReceived: true,
    wsConnected: true,
    opcuaConnected: {},
    ...overrides,
  };
}

function meta(type: VarType, extra: Partial<VarMeta> = {}): VarMeta {
  return { type, ...extra };
}

const structArray: VarType = {
  kind: 'struct',
  name: 'Alarm',
  array: true,
  fields: ['id', 'label'],
};

function structArraySpec(overrides: Partial<BindingSpec> = {}): BindingSpec {
  return {
    id: 'PLC:Alarms',
    accept: [{ kind: 'struct', array: true }],
    ...overrides,
  };
}

describe('checkBindingSpec', () => {
  it('judges a bit of a whole number as a Boolean, its word deciding access', () => {
    const s = slice({
      values: { 'Plant:Status': 32, 'Plant:Speed': 1.5 },
      varMeta: {
        'Plant:Status': meta({ kind: 'scalar', base: 'Integer', array: false }, { writable: true }),
        'Plant:Speed': meta({ kind: 'scalar', base: 'Float', array: false }),
      },
    });
    const bool: AcceptType = { kind: 'scalar', base: 'Boolean', array: false };
    const int: AcceptType = { kind: 'scalar', base: 'Integer', array: false };
    const spec = (id: string, bit: number, accept: AcceptType) => ({ id, bit, accept: [accept] });
    expect(checkBindingSpec({ ...spec('Plant:Status', 5, bool), write: true }, s, true)).toBe('ok');
    expect(checkBindingSpec(spec('Plant:Status', 5, int), s, true)).toBe('invalid');
    expect(checkBindingSpec(spec('Plant:Status', 32, bool), s, true)).toBe('invalid');
    expect(checkBindingSpec(spec('Plant:Speed', 0, bool), s, true)).toBe('invalid');
  });

  it('reports ok for an empty struct[] variable once metadata confirms the shape', () => {
    const s = slice({ values: { 'PLC:Alarms': [] }, varMeta: { 'PLC:Alarms': meta(structArray) } });
    expect(checkBindingSpec(structArraySpec(), s, true)).toBe('ok');
  });

  it('reports pending (not invalid) for a struct[] binding before any live value arrives', () => {
    const s = slice({ varMeta: { 'PLC:Alarms': meta(structArray) } });
    expect(checkBindingSpec(structArraySpec(), s, true)).toBe('pending');
  });

  it('agrees between the "no live data yet" and "live data present" checks for struct[]', () => {
    const spec = structArraySpec();
    const beforeData = slice({ varMeta: { 'PLC:Alarms': meta(structArray) } });
    const afterEmptyData = slice({
      values: { 'PLC:Alarms': [] },
      varMeta: { 'PLC:Alarms': meta(structArray) },
    });
    expect(checkBindingSpec(spec, beforeData, true)).not.toBe('invalid');
    expect(checkBindingSpec(spec, afterEmptyData, true)).not.toBe('invalid');
  });

  it('flags invalid when metadata says the variable is a plain struct, not struct[]', () => {
    const plainStruct: VarType = { kind: 'struct', name: 'Alarm', array: false, fields: ['id'] };
    const s = slice({ values: { 'PLC:Alarms': {} }, varMeta: { 'PLC:Alarms': meta(plainStruct) } });
    expect(checkBindingSpec(structArraySpec(), s, true)).toBe('invalid');
  });

  it('flags invalid when the variable does not exist in metadata at all', () => {
    expect(checkBindingSpec(structArraySpec(), slice(), true)).toBe('invalid');
  });

  it('reports pending when metadata has not been received yet, regardless of shape', () => {
    expect(checkBindingSpec(structArraySpec(), slice(), false)).toBe('pending');
  });

  it('validates a scalar binding by base type and array-ness from metadata', () => {
    const s = slice({
      values: { 'PLC:Speed': 12.5 },
      varMeta: { 'PLC:Speed': meta({ kind: 'scalar', base: 'Float', array: false }) },
    });
    const spec: BindingSpec = {
      id: 'PLC:Speed',
      accept: [{ kind: 'scalar', base: 'Integer', array: false }],
    };
    expect(checkBindingSpec(spec, s, true)).toBe('invalid');
  });

  it('accepts a String[] variable bound to a string[] slot (Dropdown options regression)', () => {
    const s = slice({
      values: { 'Static:NewArray': ['a'] },
      varMeta: {
        'Static:NewArray': meta({ kind: 'scalar', base: 'String', array: true, length: 5 }),
      },
    });
    const spec: BindingSpec = {
      id: 'Static:NewArray',
      accept: [
        { kind: 'scalar', base: 'String', array: true },
        { kind: 'scalar', base: 'Integer', array: true },
      ],
    };
    expect(checkBindingSpec(spec, s, true)).toBe('ok');
  });

  it('accepts an indexed Integer[] element bound to a scalar slot (ValueDisplay regression)', () => {
    const s = slice({
      values: { 'LegacyPLC:Arrays/EventCounters': [0, 0, 0, 0] },
      varMeta: {
        'LegacyPLC:Arrays/EventCounters': meta({
          kind: 'scalar',
          base: 'Integer',
          array: true,
          length: 6,
        }),
      },
    });
    const spec: BindingSpec = {
      id: 'LegacyPLC:Arrays/EventCounters',
      index: 3,
      accept: [
        { kind: 'scalar', base: 'Float', array: false },
        { kind: 'scalar', base: 'Integer', array: false },
        { kind: 'scalar', base: 'Boolean', array: false },
      ],
    };
    expect(checkBindingSpec(spec, s, true)).toBe('ok');
  });

  it('flags invalid when a whole array is bound (no index) to a scalar slot', () => {
    const s = slice({
      values: { 'LegacyPLC:Arrays/EventCounters': [0, 0] },
      varMeta: {
        'LegacyPLC:Arrays/EventCounters': meta({ kind: 'scalar', base: 'Integer', array: true }),
      },
    });
    const spec: BindingSpec = {
      id: 'LegacyPLC:Arrays/EventCounters',
      accept: [{ kind: 'scalar', base: 'Integer', array: false }],
    };
    expect(checkBindingSpec(spec, s, true)).toBe('invalid');
  });

  it('validates an indexed struct[] element as a single struct and waits for its element key', () => {
    const spec = structArraySpec({
      index: 1,
      accept: [{ kind: 'struct', array: false }],
    });
    const base = slice({
      values: { 'PLC:Alarms': [{ id: 1 }, { id: 2 }] },
      varMeta: {
        'PLC:Alarms': meta(structArray),
        'PLC:Alarms/[1]': meta({ ...structArray, array: false }, { position: 1 }),
      },
    });

    expect(checkBindingSpec(spec, base, true)).toBe('pending');
    expect(
      checkBindingSpec(
        {
          ...spec,
          accept: [{ kind: 'struct', array: true }],
        },
        base,
        true,
      ),
    ).toBe('invalid');
    expect(
      checkBindingSpec(
        spec,
        {
          ...base,
          values: { ...base.values, 'PLC:Alarms/[1]': { id: 2 } },
        },
        true,
      ),
    ).toBe('ok');
  });

  it('rejects an index on a non-array and a fixed scalar-array index beyond metadata length', () => {
    const scalarSlot = [{ kind: 'scalar', base: 'Integer', array: false }] as const;
    expect(
      checkBindingSpec(
        { id: 'PLC:Count', index: 0, accept: [...scalarSlot] },
        slice({
          values: { 'PLC:Count': 3 },
          varMeta: {
            'PLC:Count': meta({ kind: 'scalar', base: 'Integer', array: false }),
          },
        }),
        true,
      ),
    ).toBe('invalid');
    expect(
      checkBindingSpec(
        { id: 'PLC:Counts', index: 2, accept: [...scalarSlot] },
        slice({
          values: { 'PLC:Counts': [1, 2] },
          varMeta: {
            'PLC:Counts': meta({ kind: 'scalar', base: 'Integer', array: true, length: 2 }),
          },
        }),
        true,
      ),
    ).toBe('invalid');
  });
});

describe('checkBindingSpec — base types and struct members', () => {
  const integer: VarType = { kind: 'scalar', base: 'Integer', array: false };
  const float: VarType = { kind: 'scalar', base: 'Float', array: false };
  const floatSlot = [{ kind: 'scalar', base: 'Float', array: false }] as const;

  it('keeps an Integer variable out of a Float slot', () => {
    const s = slice({ values: { 'PLC:Count': 3 }, varMeta: { 'PLC:Count': meta(integer) } });
    expect(checkBindingSpec({ id: 'PLC:Count', accept: [...floatSlot] }, s, true)).toBe('invalid');
  });

  const motor: VarType = { kind: 'struct', name: 'Motor', array: false, fields: ['Speed', 'Name'] };
  const motorMeta = {
    'PLC:Motor': meta(motor),
    'PLC:Motor/Speed': meta(float, { writable: true }),
    'PLC:Motor/Name': meta({ kind: 'scalar', base: 'String', array: false }, { writable: false }),
  };
  const motorSpec = (requiredFields: BindingSpec['requiredFields']): BindingSpec => ({
    id: 'PLC:Motor',
    accept: [{ kind: 'struct', array: false }],
    requiredFields,
  });

  it("checks a struct's members for type and access, not just their names", () => {
    const s = slice({ values: { 'PLC:Motor': {} }, varMeta: motorMeta });
    expect(
      checkBindingSpec(motorSpec([{ name: 'Speed', type: 'Float', write: true }]), s, true),
    ).toBe('ok');
    expect(checkBindingSpec(motorSpec([{ name: 'Name', type: 'Float' }]), s, true)).toBe('invalid');
    expect(checkBindingSpec(motorSpec([{ name: 'Name', write: true }]), s, true)).toBe('invalid');
  });

  const motors: VarType = { ...motor, name: 'Motors', array: true };
  const writtenSpeed = [{ name: 'Speed', write: true }];
  // Each element folder names its position, from 0 whatever the PLC counts from.
  const motorsMeta = (first: number) => ({
    'PLC:Motors': meta(motors),
    [`PLC:Motors/Line[${first}]`]: meta(motor, { position: 0 }),
    [`PLC:Motors/Line[${first + 1}]`]: meta(motor, { position: 1 }),
    [`PLC:Motors/Line[${first}]/Speed`]: meta(float, { writable: false }),
    [`PLC:Motors/Line[${first}]/Name`]: meta(float),
    [`PLC:Motors/Line[${first + 1}]/Speed`]: meta(float, { writable: true }),
    [`PLC:Motors/Line[${first + 1}]/Name`]: meta(float),
  });
  const wholeSpec: BindingSpec = {
    id: 'PLC:Motors',
    accept: [{ kind: 'struct', array: true }],
    requiredFields: writtenSpeed,
  };
  const elementSpec = (index: number): BindingSpec => ({
    id: 'PLC:Motors',
    index,
    accept: [{ kind: 'struct', array: false }],
    requiredFields: writtenSpeed,
  });

  it("judges a struct array's members on the bound element, else the lowest one", () => {
    const s = slice({
      // Element values live under the element folder's own name, as the
      // backend ships them.
      values: {
        'PLC:Motors': [],
        'PLC:Motors/Line[0]': {},
        'PLC:Motors/Line[1]': {},
        'PLC:Motors/Line[7]': {},
      },
      varMeta: motorsMeta(0),
    });
    // Line[0] — read-only Speed — whatever the folder prefix; Line[1] writable.
    expect(checkBindingSpec(wholeSpec, s, true)).toBe('invalid');
    expect(checkBindingSpec(elementSpec(0), s, true)).toBe('invalid');
    expect(checkBindingSpec(elementSpec(1), s, true)).toBe('ok');
    // An index with no element of its own falls back to the lowest.
    expect(checkBindingSpec(elementSpec(7), s, true)).toBe('invalid');
  });

  it('judges a struct array that counts from 1', () => {
    const s = slice({ values: { 'PLC:Motors': [] }, varMeta: motorsMeta(1) });
    expect(checkBindingSpec(wholeSpec, s, true)).toBe('invalid');
  });

  it('fails a writing field unless the variable is known to be writable', () => {
    const speed = (writable?: boolean) =>
      slice({
        values: { 'PLC:Speed': 1 },
        varMeta: { 'PLC:Speed': meta(float, writable === undefined ? {} : { writable }) },
      });
    const written: BindingSpec = { id: 'PLC:Speed', accept: [...floatSlot], write: true };
    expect(checkBindingSpec(written, speed(false), true)).toBe('invalid');
    expect(checkBindingSpec({ ...written, write: undefined }, speed(false), true)).toBe('ok');
    expect(checkBindingSpec(written, speed(true), true)).toBe('ok');
    // Access the metadata does not state is read-only, as the picker and backend read it.
    expect(checkBindingSpec(written, speed(), true)).toBe('invalid');
  });

  it('judges a struct on a writing field by its members, not its own access', () => {
    const written = motorSpec([{ name: 'Speed', write: true }]);
    const s = slice({ values: { 'PLC:Motor': {} }, varMeta: motorMeta });
    expect(checkBindingSpec({ ...written, write: true }, s, true)).toBe('ok');
    const nameWritten = motorSpec([{ name: 'Name', write: true }]);
    expect(checkBindingSpec({ ...nameWritten, write: true }, s, true)).toBe('invalid');
  });

  it('re-judges a struct when only its member metadata changes', () => {
    const selector = createBindingStatusSelector([motorSpec([{ name: 'Name', write: true }])]);
    const base = slice({ values: { 'PLC:Motor': {} }, varMeta: motorMeta });
    expect(selector(base)).toBe('disabled');
    const nameWritable = {
      ...motorMeta,
      'PLC:Motor/Name': { ...motorMeta['PLC:Motor/Name'], writable: true },
    };
    expect(selector({ ...base, varMeta: nameWritable })).toBe('ok');
  });
});

describe('checkBindingSpec — a member of a struct bound whole', () => {
  // A dialog handed `device` = `PLC:M1/sstDev` reads `device/Hmi/fPos`; only the
  // struct is subscribed, so the member arrives inside its record.
  const float = meta({ kind: 'scalar', base: 'Float', array: false });
  const leaf = 'PLC:M1/sstDev/Hmi/fPos';
  const spec: BindingSpec = { id: leaf, accept: [] };

  it('is ok once the struct holding it has arrived', () => {
    const s = slice({
      values: { 'PLC:M1/sstDev': { Hmi: { fPos: 0 } } },
      varMeta: { [leaf]: float },
    });
    expect(checkBindingSpec(spec, s, true)).toBe('ok');
  });

  it('is pending while neither it nor the struct has', () => {
    expect(checkBindingSpec(spec, slice({ varMeta: { [leaf]: float } }), true)).toBe('pending');
  });

  it('is re-judged when only the struct holding it changes', () => {
    const selector = createBindingStatusSelector([spec]);
    const before = slice({ values: {}, varMeta: { [leaf]: float } });
    expect(selector(before)).toBe('nodata');
    expect(selector({ ...before, values: { 'PLC:M1/sstDev': { Hmi: { fPos: 1 } } } })).toBe('ok');
  });
});

describe('checkBindingSpec — a member of a struct-array element', () => {
  // `$componentProp: "device/sName"` on an instance passing `PLC:Motors` at 1,
  // a TwinCAT array counting from 1, binds the member's leaf. The server ships
  // element [2] and the metadata below it; the leaf is filled in from it.
  const motors: VarType = { kind: 'struct', name: 'Motor', array: true, fields: ['sName'] };
  const elementMeta = {
    'PLC:Motors': meta(motors),
    'PLC:Motors/Motors[2]': meta({ ...motors, array: false }, { position: 1 }),
    'PLC:Motors/Motors[2]/sName': meta(
      { kind: 'scalar', base: 'String', array: false },
      { writable: true },
    ),
  };
  const shipped = { 'PLC:Motors/Motors[2]': { sName: 'Pump 2' } };
  const arrived = slice({
    values: { ...shipped, ...elementMemberValues(shipped, elementMeta) },
    varMeta: elementMeta,
  });
  const member = (overrides: Partial<BindingSpec> = {}): BindingSpec => ({
    id: 'PLC:Motors/Motors[2]/sName',
    accept: [{ kind: 'scalar', base: 'String', array: false }],
    ...overrides,
  });

  it('is ok once the element arrives', () => {
    expect(checkBindingSpec(member(), arrived, true)).toBe('ok');
    expect(checkBindingSpec(member({ write: true }), arrived, true)).toBe('ok');
  });

  it('waits for the element', () => {
    expect(checkBindingSpec(member(), { ...arrived, values: {} }, true)).toBe('pending');
  });

  it("is invalid for the leaf's wrong type or access, or a member the element lacks", () => {
    const integer: AcceptType = { kind: 'scalar', base: 'Integer', array: false };
    expect(checkBindingSpec(member({ accept: [integer] }), arrived, true)).toBe('invalid');
    const readOnly = slice({
      ...arrived,
      varMeta: {
        ...elementMeta,
        'PLC:Motors/Motors[2]/sName': meta({ kind: 'scalar', base: 'String', array: false }),
      },
    });
    expect(checkBindingSpec(member({ write: true }), readOnly, true)).toBe('invalid');
    const missing = member({ id: 'PLC:Motors/Motors[2]/sMissing' });
    expect(checkBindingSpec(missing, arrived, true)).toBe('invalid');
    // Until the metadata is authoritative a missing member only waits.
    expect(checkBindingSpec(missing, arrived, false)).toBe('pending');
  });
});

describe('extractBindingSpecs', () => {
  it("carries the field's write flag onto the spec", () => {
    const [spec] = extractBindingSpecs(
      { setpoint: { $var: { path: 'PLC:Setpoint' } } },
      { setpoint: { type: 'float', write: true } },
    );
    expect(spec).toMatchObject({ id: 'PLC:Setpoint', write: true });
  });

  it('picks up a $var nested in an expression, with no type constraint of its own', () => {
    const specs = extractBindingSpecs(
      {
        value: {
          $stringExpr: {
            template: '{1}',
            wildcards: { 1: { $var: { path: 'PLC:Tanks/T1Volume' } } },
          },
        },
      },
      { value: { type: 'string' } },
    );
    expect(specs).toEqual([{ id: 'PLC:Tanks/T1Volume', accept: [] }]);
  });

  it('does not list a variable twice when a slot also binds it directly', () => {
    const specs = extractBindingSpecs(
      {
        level: { $var: { path: 'PLC:Speed' } },
        label: {
          $stringExpr: { template: '{1}', wildcards: { 1: { $var: { path: 'PLC:Speed' } } } },
        },
      },
      { level: { type: 'number' } },
    );
    expect(specs.map((spec) => spec.id)).toEqual(['PLC:Speed']);
  });

  it('checks an $if discriminant but not the branch that lost', () => {
    const specs = extractBindingSpecs(
      {
        label: {
          $if: {
            condition: { $var: { path: 'PLC:Running' } },
            true: { $var: { path: 'PLC:Rpm' } },
            false: { $var: { path: 'PLC:Spare' } },
          },
        },
      },
      { label: { type: 'string' } },
    );
    // The condition is read on every render; at most one of the two results is
    // ever on screen, so neither can be said to be missing.
    expect(specs.map((spec) => spec.id)).toEqual(['PLC:Running']);
  });

  it('checks a $switch discriminant and its cases, not their results', () => {
    const specs = extractBindingSpecs(
      {
        label: {
          $switch: {
            value: { $var: { path: 'PLC:Mode' } },
            cases: [
              { when: { $var: { path: 'PLC:ManualMode' } }, then: { $var: { path: 'PLC:A' } } },
            ],
            default: { $var: { path: 'PLC:B' } },
          },
        },
      },
      { label: { type: 'string' } },
    );
    expect(specs.map((spec) => spec.id).sort()).toEqual(['PLC:ManualMode', 'PLC:Mode']);
  });

  describe('with the branch the render takes', () => {
    const values: Record<string, unknown> = {};
    const ctx: EvaluationContext = {
      resolveVariable: (ds, path) => (values[`${ds}:${path}`] ?? null) as ResolvedValue,
    };
    const running = {
      $if: {
        condition: { $var: { path: 'PLC:Running' } },
        true: { $var: { path: 'PLC:Rpm' } },
        false: { $var: { path: 'PLC:Spare' } },
      },
    };

    it('types an $if result against the field, and only the result it takes', () => {
      values['PLC:Running'] = true;
      const specs = extractBindingSpecs(
        { level: running },
        { level: { type: 'float', write: true } },
        ctx,
      );
      expect(specs).toEqual([
        {
          id: 'PLC:Rpm',
          index: undefined,
          accept: [{ kind: 'scalar', base: 'Float', array: false }],
          requiredFields: undefined,
          write: true,
        },
        { id: 'PLC:Running', accept: [] },
      ]);
      values['PLC:Running'] = false;
      expect(
        extractBindingSpecs({ level: running }, { level: { type: 'float' } }, ctx)[0],
      ).toMatchObject({
        id: 'PLC:Spare',
        accept: [{ kind: 'scalar', base: 'Float', array: false }],
      });
    });

    it('follows a $switch case into a nested $if, and falls back to its default', () => {
      values['PLC:Mode'] = 2;
      values['PLC:Running'] = true;
      const level = {
        $switch: {
          value: { $var: { path: 'PLC:Mode' } },
          cases: [{ when: 2, then: running }],
          default: { $var: { path: 'PLC:Idle', index: 1 } },
        },
      };
      const schema = { level: { type: 'float' } };
      // The nested `$if`'s condition sits in the taken `then`, so it is read too.
      expect(extractBindingSpecs({ level }, schema, ctx).map((s) => s.id)).toEqual([
        'PLC:Rpm',
        'PLC:Mode',
        'PLC:Running',
      ]);
      values['PLC:Mode'] = 3;
      expect(extractBindingSpecs({ level }, schema, ctx)[0]).toMatchObject({
        id: 'PLC:Idle',
        index: 1,
        accept: [{ kind: 'scalar', base: 'Float', array: false }],
      });
    });

    it('lets the typed spec win over the same variable used as the condition', () => {
      values['PLC:Running'] = true;
      const specs = extractBindingSpecs(
        {
          label: {
            $if: {
              condition: { $var: { path: 'PLC:Running' } },
              true: { $var: { path: 'PLC:Running' } },
            },
          },
        },
        { label: { type: 'boolean' } },
        ctx,
      );
      expect(specs).toHaveLength(1);
      expect(specs[0]).toMatchObject({
        id: 'PLC:Running',
        accept: [{ kind: 'scalar', base: 'Boolean' }],
      });
    });

    it('resolves a $componentProp result through the input scope', () => {
      values['PLC:Running'] = false;
      const specs = extractBindingSpecs(
        {
          level: {
            $if: {
              condition: { $var: { path: 'PLC:Running' } },
              false: { $componentProp: 'speed' },
            },
          },
        },
        { level: { type: 'float' } },
        { ...ctx, inputScopeProps: { speed: { $var: { path: 'PLC:Speed' } } } },
      );
      expect(specs[0]).toMatchObject({ id: 'PLC:Speed' });
    });

    it('checks the variables of a taken result that is not a whole $var for presence', () => {
      values['PLC:Running'] = true;
      const wildcard = (path: string) => ({
        $stringExpr: { template: '{1}', wildcards: { 1: { $var: { path } } } },
      });
      const label = {
        $if: {
          condition: { $var: { path: 'PLC:Running' } },
          true: wildcard('PLC:Rpm'),
          false: wildcard('PLC:Spare'),
        },
      };
      const specs = extractBindingSpecs({ label }, { label: { type: 'string' } }, ctx);
      // The losing `false` stays out; the template on screen has no slot to type.
      expect(specs).toEqual([
        { id: 'PLC:Running', accept: [] },
        { id: 'PLC:Rpm', accept: [] },
      ]);
    });

    it('reads the taken side of a branch nested inside a template', () => {
      values['PLC:Running'] = false;
      const specs = extractBindingSpecs(
        {
          label: {
            $formula: {
              expression: '{1} * 2',
              wildcards: {
                1: {
                  $if: {
                    condition: { $var: { path: 'PLC:Running' } },
                    true: { $var: { path: 'PLC:Rpm' } },
                    false: { $var: { path: 'PLC:Spare' } },
                  },
                },
              },
            },
          },
        },
        { label: { type: 'float' } },
        ctx,
      );
      expect(specs).toEqual([
        { id: 'PLC:Running', accept: [] },
        { id: 'PLC:Spare', accept: [] },
      ]);
    });

    it('still ignores branches that only gate visibility or fire on press', () => {
      values['PLC:Running'] = true;
      const specs = extractBindingSpecs(
        { visible: running, onPress: running },
        { onPress: { type: 'actions' } },
        ctx,
      );
      expect(specs).toEqual([]);
    });
  });

  it('ignores variables that only gate visibility or only fire on press', () => {
    const compare = (path: string) => ({
      $compare: { left: { $var: { path } }, operator: '>', right: 0 },
    });
    const specs = extractBindingSpecs(
      {
        visible: compare('PLC:ShowIt'),
        interactable: compare('PLC:Enabled'),
        onPress: { events: [{ params: { value: compare('PLC:Cmd') } }] },
      },
      { onPress: { type: 'actions' } },
    );
    // None of the three is something the widget is *showing* — marking it for
    // them would put an overlay on a widget that renders correctly.
    expect(specs).toEqual([]);
  });

  it('ignores a visibility gate even when its whole value collapses to a plain $var', () => {
    // `visible: { $componentProp: … }` resolves to a plain `$var` once the
    // instance supplies one — the direct getPropBinding match above the nested
    // walk must not pick that up either, or a resolved gate would out-mark
    // itself despite the check above.
    expect(extractBindingSpecs({ visible: { $var: { path: 'PLC:ShowIt' } } }, {})).toEqual([]);
  });

  it('claims nothing for a property the schema does not declare', () => {
    // `registerCustomWidget` registers a widget whose exports could not be read
    // (`schemaError`) with only the visibility gates, so every property on it
    // lands here with no field — `actions` included. Harvesting those would put
    // an amber "no data" mark on a widget that renders and works, for a
    // variable only its press handler writes.
    const specs = extractBindingSpecs(
      {
        onPress: {
          events: [
            {
              params: {
                value: {
                  $compare: { left: { $var: { path: 'PLC:Cmd' } }, operator: '>', right: 0 },
                },
              },
            },
          ],
        },
      },
      {},
    );
    expect(specs).toEqual([]);
  });
});

describe('aggregateBindingStatus', () => {
  const spec: BindingSpec = { id: 'PLC:Speed', accept: [] };
  const cached = slice({
    values: { 'PLC:Speed': 12.5 },
    varMeta: {
      'PLC:Speed': meta({ kind: 'scalar', base: 'Float', array: false }),
    },
  });

  it('does not report cached values as healthy after the WebSocket disconnects', () => {
    expect(aggregateBindingStatus([spec], { ...cached, wsConnected: false })).toBe('disconnected');
  });

  it('does not report cached values as healthy after the datasource disconnects', () => {
    expect(aggregateBindingStatus([spec], { ...cached, opcuaConnected: { PLC: false } })).toBe(
      'disconnected',
    );
  });

  it('reports a sound binding with no value as nodata, not as a broken one', () => {
    const noValue = slice({
      varMeta: { 'PLC:Speed': meta({ kind: 'scalar', base: 'Float', array: false }) },
    });
    expect(aggregateBindingStatus([spec], noValue)).toBe('nodata');
  });

  it('keeps the red overlay for a variable no datasource knows', () => {
    expect(aggregateBindingStatus([spec], slice())).toBe('disabled');
  });

  it('says nodata before the metadata has landed — nothing is known to be wrong yet', () => {
    expect(aggregateBindingStatus([spec], slice({ metadataReceived: false }))).toBe('nodata');
  });
});

describe('createBindingStatusSelector', () => {
  it('skips the O(n) recompute when a store update only touches a key nothing depends on', () => {
    const scalarMeta = meta({ kind: 'scalar', base: 'Float', array: false });
    const specA: BindingSpec = { id: 'PLC:A', accept: [] };

    let recomputeCount = 0;
    const selector = createBindingStatusSelector([specA], true, () => {
      recomputeCount++;
    });

    const base = slice({ values: { 'PLC:A': 1 }, varMeta: { 'PLC:A': scalarMeta } });
    expect(selector(base)).toBe('ok');
    expect(recomputeCount).toBe(1);

    const withUnrelatedKeyChanged: BindingStoreSlice = {
      ...base,
      values: { ...base.values, 'PLC:B': 42 },
    };
    expect(selector(withUnrelatedKeyChanged)).toBe('ok');
    expect(recomputeCount).toBe(1); // no recompute — B isn't a dependency

    const withDependencyChanged: BindingStoreSlice = {
      ...base,
      values: { ...base.values, 'PLC:A': 2 },
    };
    expect(selector(withDependencyChanged)).toBe('ok');
    expect(recomputeCount).toBe(2);
  });

  it('recomputes when a global flag (wsConnected) changes even if no bound value did', () => {
    const scalarMeta = meta({ kind: 'scalar', base: 'Float', array: false });
    const specA: BindingSpec = { id: 'PLC:A', accept: [] };

    let recomputeCount = 0;
    const selector = createBindingStatusSelector([specA], true, () => {
      recomputeCount++;
    });

    const base = slice({
      values: { 'PLC:A': 1 },
      varMeta: { 'PLC:A': scalarMeta },
      wsConnected: true,
    });
    selector(base);
    expect(recomputeCount).toBe(1);

    const disconnected: BindingStoreSlice = { ...base, wsConnected: false };
    selector(disconnected);
    expect(recomputeCount).toBe(2);
  });

  it('recomputes an indexed struct binding when its concrete element key changes', () => {
    const selector = createBindingStatusSelector([
      { id: 'PLC:Alarms', index: 1, accept: [{ kind: 'struct', array: false }] },
    ]);
    const base = slice({
      values: {
        'PLC:Alarms': [{ id: 1 }, { id: 2 }],
      },
      varMeta: {
        'PLC:Alarms': meta(structArray),
        'PLC:Alarms/[1]': meta({ ...structArray, array: false }, { position: 1 }),
      },
    });

    // The element key has not been delivered yet — no data, not a bad binding.
    expect(selector(base)).toBe('nodata');
    expect(
      selector({
        ...base,
        values: { ...base.values, 'PLC:Alarms/[1]': { id: 2 } },
      }),
    ).toBe('ok');
  });

  it('waits on the element a page metadata positions, not the one its rank gives', () => {
    // TwinCAT ARRAY[1..10] bound at position 5 only: the page holds element [6] alone.
    const selector = createBindingStatusSelector([
      { id: 'PLC:Alarms', index: 5, accept: [{ kind: 'struct', array: false }] },
    ]);
    const base = slice({
      varMeta: {
        'PLC:Alarms': meta(structArray),
        'PLC:Alarms/[6]': meta({ ...structArray, array: false }, { position: 5 }),
      },
    });
    expect(selector(base)).toBe('nodata');
    expect(selector({ ...base, values: { 'PLC:Alarms/[6]': { id: 6 } } })).toBe('ok');
  });

  it('never takes another position for a bound index the metadata holds no element at', () => {
    const elementMeta = (position: number) => meta({ ...structArray, array: false }, { position });
    const status = (index: number, s: BindingStoreSlice) =>
      createBindingStatusSelector([
        { id: 'PLC:Alarms', index, accept: [{ kind: 'struct', array: false }] },
      ])(s);
    // ARRAY[1..10] bound at 9 and 10: only position 9, element [10], exists.
    const pastEnd = slice({
      values: { 'PLC:Alarms/[10]': { id: 10 } },
      varMeta: { 'PLC:Alarms': meta(structArray), 'PLC:Alarms/[10]': elementMeta(9) },
    });
    expect(status(9, pastEnd)).toBe('ok');
    expect(status(10, pastEnd)).toBe('nodata');
    // The previous page's metadata, which held position 0 — element [1].
    const stale = slice({
      values: { 'PLC:Alarms/[1]': { id: 1 } },
      varMeta: { 'PLC:Alarms': meta(structArray), 'PLC:Alarms/[1]': elementMeta(0) },
    });
    expect(status(1, stale)).toBe('nodata');
  });

  it('re-judges a member of an element when its metadata lands after the value', () => {
    const selector = createBindingStatusSelector([
      { id: 'PLC:Motors/[1]/sName', accept: [{ kind: 'scalar', base: 'String', array: false }] },
    ]);
    const motors: VarType = { kind: 'struct', name: 'Motor', array: true, fields: ['sName'] };
    // This page's element has arrived; the previous page's metadata is still in the store.
    const previous = slice({
      values: { 'PLC:Motors/[1]': { sName: 'Pump 1' }, 'PLC:Motors/[1]/sName': 'Pump 1' },
      varMeta: { 'PLC:Other': meta({ kind: 'scalar', base: 'Float', array: false }) },
    });
    expect(selector(previous)).toBe('disabled');
    // This page's metadata, the same values object.
    const landed = {
      ...previous,
      varMeta: {
        'PLC:Motors': meta(motors),
        'PLC:Motors/[1]': meta({ ...motors, array: false }, { position: 0 }),
        'PLC:Motors/[1]/sName': meta({ kind: 'scalar', base: 'String', array: false }),
      },
    };
    expect(selector(landed)).toBe('ok');
    expect(selector({ ...landed, values: {} })).toBe('nodata');
  });

  it('watches no element key for a scalar array bound at an index', () => {
    let recomputeCount = 0;
    const selector = createBindingStatusSelector(
      [{ id: 'PLC:Zones', index: 1, accept: [] }],
      true,
      () => recomputeCount++,
    );
    const base = slice({
      values: { 'PLC:Zones': [10, 20, 30] },
      varMeta: { 'PLC:Zones': meta({ kind: 'scalar', base: 'Integer', array: true }) },
    });
    expect(selector(base)).toBe('ok');
    // A key in `[N]` form is no element of a scalar array, so it is no dependency.
    selector({ ...base, values: { ...base.values, 'PLC:Zones/[1]': 99 } });
    expect(recomputeCount).toBe(1);
  });
});
