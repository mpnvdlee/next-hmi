import {
  aggregateBindingStatus,
  checkBindingSpec,
  createBindingStatusSelector,
  type BindingSpec,
  type BindingStoreSlice,
} from './bindingValidation';
import type { VarMeta } from '../store/variableStore';
import type { VarType } from '@shared/types/varType';

function slice(overrides: Partial<BindingStoreSlice> = {}): BindingStoreSlice {
  return {
    values: {},
    varMeta: {},
    metadataReceived: true,
    wsConnected: true,
    opcuaConnected: {},
    snapshotReceived: true,
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
  it('reports ok for an empty struct[] variable once metadata confirms the shape (§10.3)', () => {
    const s = slice({ values: { 'PLC:Alarms': [] }, varMeta: { 'PLC:Alarms': meta(structArray) } });
    expect(checkBindingSpec(structArraySpec(), s, true)).toBe('ok');
  });

  it('reports pending (not invalid) for a struct[] binding before any live value arrives', () => {
    const s = slice({ varMeta: { 'PLC:Alarms': meta(structArray) } });
    expect(checkBindingSpec(structArraySpec(), s, true)).toBe('pending');
  });

  it('agrees between the "no live data yet" and "live data present" checks for struct[] (§10.4)', () => {
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
      varMeta: { 'PLC:Alarms': meta(structArray) },
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
});

describe('createBindingStatusSelector', () => {
  it('skips the O(n) recompute when a store update only touches a key nothing depends on (§7.5)', () => {
    const scalarMeta = meta({ kind: 'scalar', base: 'Float', array: false });
    const specA: BindingSpec = { id: 'PLC:A', accept: [] };

    let recomputeCount = 0;
    const selector = createBindingStatusSelector([specA], () => {
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
    const selector = createBindingStatusSelector([specA], () => {
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
      varMeta: { 'PLC:Alarms': meta(structArray) },
    });

    expect(selector(base)).toBe('disabled');
    expect(
      selector({
        ...base,
        values: { ...base.values, 'PLC:Alarms/[1]': { id: 2 } },
      }),
    ).toBe('ok');
  });
});
