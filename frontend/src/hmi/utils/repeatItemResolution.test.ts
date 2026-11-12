import type { RepeatScopeValue } from '../context/RepeatScopeContext';
import { evaluatePropertyValue, type ResolvedValue } from './propertySourceEval';
import {
  containsRepeatRef,
  elementMemberValues,
  memberLeafKey,
  readArrayElement,
  resolveRepeatItem,
  structElementKey,
  structElementPath,
  structShapeElementPath,
  substituteRepeatRefs,
} from './repeatItemResolution';
import { writeTargetAddress } from '@shared/types/config';

function scope(patch: Partial<RepeatScopeValue>): RepeatScopeValue {
  return { index: 0, item: undefined, key: 'r#0', first: true, ...patch };
}

// As the backend sends it: each element folder names its position.
const META = {
  'PLC:Motors': {},
  'PLC:Motors/Line[0]': { position: 0 },
  'PLC:Motors/Line[0]/Speed': {},
  'PLC:Motors/Line[1]': { position: 1 },
  'PLC:Motors/Line[1]/Speed': {},
  'PLC:Motors/Line[1]/Name': {},
  'PLC:MotorsExtra/[1]': { position: 0 },
  'PLC:MotorsExtra/[1]/Speed': {},
};

describe('structElementPath', () => {
  it('finds the element folder the metadata positions at the index', () => {
    expect(structElementPath(META, 'PLC:Motors', 1)).toBe('PLC:Motors/Line[1]');
  });

  it('does not match an array whose name merely starts the same', () => {
    expect(structElementPath(META, 'PLC:Motors', 5)).toBeUndefined();
    expect(structElementPath(META, 'PLC:MotorsExtra', 0)).toBe('PLC:MotorsExtra/[1]');
  });
});

describe('elements of a page that binds only some of them', () => {
  // A page's metadata holds the bound elements alone, each naming its position.
  const S = { kind: 'struct', name: 'ST_Motor', array: true, fields: ['Speed'] };
  const F = { type: { kind: 'scalar', base: 'Float', array: false } };
  function partial(names: Record<string, number>): Record<string, unknown> {
    const meta: Record<string, unknown> = { 'PLC:Motors': { type: S } };
    for (const [name, position] of Object.entries(names)) {
      meta[`PLC:Motors/${name}`] = { type: { ...S, name, array: false }, position };
      meta[`PLC:Motors/${name}/Speed`] = F;
    }
    return meta;
  }
  const valuesOf = (meta: Record<string, unknown>) =>
    Object.fromEntries(
      Object.keys(meta)
        .filter((key) => key.split('/').length === 2)
        .map((key) => [key, { Speed: key }]),
    );

  it('finds a 0-based element by its position, not its rank among those present', () => {
    const meta = partial({ '[1]': 1, '[2]': 2, '[5]': 5 });
    const values = valuesOf(meta);
    expect(structElementKey(meta, 'PLC:Motors', 1)).toBe('PLC:Motors/[1]');
    expect(structElementKey(meta, 'PLC:Motors', 2)).toBe('PLC:Motors/[2]');
    expect(readArrayElement(values, meta, 'PLC:Motors', 5)).toEqual({ Speed: 'PLC:Motors/[5]' });
  });

  it('finds an element of a 1-based PLC array by its position', () => {
    // TwinCAT ARRAY[1..10]: positions 1, 2 and 5 are elements [2], [3] and [6].
    const meta = partial({ '[2]': 1, '[3]': 2, '[6]': 5 });
    const values = valuesOf(meta);
    expect(structElementKey(meta, 'PLC:Motors', 1)).toBe('PLC:Motors/[2]');
    expect(structElementKey(meta, 'PLC:Motors', 2)).toBe('PLC:Motors/[3]');
    expect(readArrayElement(values, meta, 'PLC:Motors', 5)).toEqual({ Speed: 'PLC:Motors/[6]' });
    // A position the page does not bind is no element it holds.
    expect(structElementPath(meta, 'PLC:Motors', 0)).toBeUndefined();
  });

  it('holds no element at a position the metadata does not name, not the `[index]` one', () => {
    // The previous page bound position 0 of an array counting from 1: until
    // this page's metadata lands, `[1]` is that page's element, not position 1.
    const stale = partial({ '[1]': 0 });
    const values = { 'PLC:Motors/[1]': { Speed: 'motor 1' } };
    expect(structElementKey(stale, 'PLC:Motors', 1)).toBeUndefined();
    expect(readArrayElement(values, stale, 'PLC:Motors', 1)).toBeUndefined();
    // The whole array, when a context holds it, still answers.
    const whole = { ...values, 'PLC:Motors': [{ Speed: 'a' }, { Speed: 'b' }] };
    expect(readArrayElement(whole, stale, 'PLC:Motors', 1)).toEqual({ Speed: 'b' });
  });

  it('holds no element past the end of a PLC array counting from 1', () => {
    // ARRAY[1..10] bound at 9 and 10: only position 9, element [10], exists.
    const meta = partial({ '[10]': 9 });
    const values = valuesOf(meta);
    expect(structElementKey(meta, 'PLC:Motors', 9)).toBe('PLC:Motors/[10]');
    expect(structElementKey(meta, 'PLC:Motors', 10)).toBeUndefined();
    expect(readArrayElement(values, meta, 'PLC:Motors', 10)).toBeUndefined();
  });

  it('reads the shape off the lowest position present when the bound one is absent', () => {
    const meta = partial({ '[6]': 5, '[3]': 2 });
    expect(structShapeElementPath(meta, 'PLC:Motors')).toBe('PLC:Motors/[3]');
    expect(structShapeElementPath(meta, 'PLC:Motors', 5)).toBe('PLC:Motors/[6]');
    expect(structShapeElementPath(meta, 'PLC:Motors', 7)).toBe('PLC:Motors/[3]');
  });

  it('slices a scalar array whole, never looking for an element key', () => {
    const meta = { 'PLC:Zones': { type: { kind: 'scalar', base: 'Integer', array: true } } };
    // A stray key in `[N]` form is no element of a scalar array.
    const values = { 'PLC:Zones': [10, 20, 30], 'PLC:Zones/[1]': 99 };
    expect(readArrayElement(values, meta, 'PLC:Zones', 1)).toBe(20);
  });

  it('slices the whole array until the metadata names the element', () => {
    // No key can be built from the index: `[1]` is position 0 of an array counting from 1.
    const values = { 'PLC:Motors': [{ Speed: 1 }, { Speed: 2 }], 'PLC:Motors/[1]': { Speed: 9 } };
    expect(structElementKey({}, 'PLC:Motors', 1)).toBeUndefined();
    expect(readArrayElement(values, {}, 'PLC:Motors', 1)).toEqual({ Speed: 2 });
  });
});

describe('a member of an indexed struct-array element', () => {
  // `$componentProp: "device/sName"` on an instance passing `PLC:Motors` at 0
  // reads `PLC:Motors/sName` at 0. The server ships the element and the
  // metadata below it, here of a TwinCAT array counting from 1.
  const S = { kind: 'struct', name: 'ST_Motor', array: true, fields: ['sName', 'stState'] };
  const META = {
    'PLC:Motors': { type: S },
    'PLC:Motors/Motors[1]': { type: { ...S, array: false }, position: 0 },
    'PLC:Motors/Motors[1]/sName': { type: { kind: 'scalar', base: 'String', array: false } },
    'PLC:Motors/Motors[1]/stState': { type: { kind: 'struct', name: 'ST', array: false } },
    'PLC:Motors/Motors[1]/stState/bOn': { type: { kind: 'scalar', base: 'Boolean', array: false } },
    'PLC:Zones': { type: { kind: 'scalar', base: 'Integer', array: true } },
  };
  const element = { sName: 'Pump 1', stState: { bOn: true } };

  it('finds the element by position and the member leaf inside it', () => {
    expect(memberLeafKey(META, 'PLC:Motors/sName', 0)).toBe('PLC:Motors/Motors[1]/sName');
    expect(memberLeafKey(META, 'PLC:Motors/stState/bOn', 0)).toBe(
      'PLC:Motors/Motors[1]/stState/bOn',
    );
    // No element at that position.
    expect(memberLeafKey(META, 'PLC:Motors/sName', 1)).toBeUndefined();
    const values = { 'PLC:Motors/Motors[1]/sName': 'Pump 1' };
    expect(readArrayElement(values, META, 'PLC:Motors/sName', 0)).toBe('Pump 1');
    expect(readArrayElement({}, META, 'PLC:Motors/sName', 0)).toBeUndefined();
  });

  it("fills in the members below an element from the element's value", () => {
    expect(elementMemberValues({ 'PLC:Motors/Motors[1]': element }, META)).toEqual({
      'PLC:Motors/Motors[1]/sName': 'Pump 1',
      'PLC:Motors/Motors[1]/stState': { bOn: true },
      'PLC:Motors/Motors[1]/stState/bOn': true,
    });
    // A member the element lacks stays as it is; nothing else is an element.
    expect(elementMemberValues({ 'PLC:Motors/Motors[1]': { sName: 'x' } }, META)).toEqual({
      'PLC:Motors/Motors[1]/sName': 'x',
    });
    expect(elementMemberValues({ 'PLC:Zones': [1, 2], 'PLC:Motors': [element] }, META)).toBe(
      undefined,
    );
  });

  it('reaches the members of an element nested in another, by position', () => {
    const A = { kind: 'struct', name: 'ST_Axis', array: true, fields: ['Pos'] };
    const nested = {
      ...META,
      'PLC:Motors/Motors[1]/Axes': { type: A },
      'PLC:Motors/Motors[1]/Axes/Axes[1]': { type: { ...A, array: false }, position: 0 },
      'PLC:Motors/Motors[1]/Axes/Axes[1]/Pos': { type: { kind: 'scalar', base: 'Float' } },
      'PLC:Motors/Motors[1]/Axes/Axes[2]': { type: { ...A, array: false }, position: 1 },
      'PLC:Motors/Motors[1]/Axes/Axes[2]/Pos': { type: { kind: 'scalar', base: 'Float' } },
    };
    // The outer element holds the nested array as a list.
    const outer = { ...element, Axes: [{ Pos: 1.5 }, { Pos: 2.5 }] };
    expect(elementMemberValues({ 'PLC:Motors/Motors[1]': outer }, nested)).toMatchObject({
      'PLC:Motors/Motors[1]/Axes/Axes[1]/Pos': 1.5,
      'PLC:Motors/Motors[1]/Axes/Axes[2]/Pos': 2.5,
    });
    // An inner element shipped on its own fills in its own.
    expect(
      elementMemberValues({ 'PLC:Motors/Motors[1]/Axes/Axes[2]': { Pos: 9 } }, nested),
    ).toEqual({ 'PLC:Motors/Motors[1]/Axes/Axes[2]/Pos': 9 });
  });

  it('leaves a key with metadata of its own alone', () => {
    expect(memberLeafKey(META, 'PLC:Motors', 0)).toBeUndefined();
    expect(memberLeafKey(META, 'PLC:Zones', 1)).toBeUndefined();
    const values = { 'PLC:Motors/Motors[1]': element };
    expect(readArrayElement(values, META, 'PLC:Motors', 0)).toBe(element);
  });

  it('ignores a scalar-array ancestor', () => {
    expect(memberLeafKey(META, 'PLC:Zones/x', 1)).toBeUndefined();
    expect(readArrayElement({ 'PLC:Zones': [1, 2] }, META, 'PLC:Zones/x', 1)).toBeUndefined();
  });
});

describe('resolveRepeatItem', () => {
  it('reads the index', () => {
    expect(resolveRepeatItem({ field: 'index' }, scope({ index: 4 }), {})).toBe(4);
  });

  it('binds a scalar array element as an indexed $var', () => {
    const s = scope({ index: 2, arrayKey: 'PLC:Setpoints' });
    expect(resolveRepeatItem({}, s, {})).toEqual({ $var: { path: 'PLC:Setpoints', index: 2 } });
  });

  it('binds a whole struct element to its own folder key', () => {
    const s = scope({ index: 1, arrayKey: 'PLC:Motors', structArray: true });
    expect(resolveRepeatItem({}, s, META)).toEqual({ $var: { path: 'PLC:Motors/Line[1]' } });
  });

  it("binds a struct member to its own leaf in the copy's element", () => {
    const s = scope({ index: 1, arrayKey: 'PLC:Motors', structArray: true });
    expect(resolveRepeatItem({ member: 'Speed' }, s, META)).toEqual({
      $var: { path: 'PLC:Motors/Line[1]/Speed' },
    });
  });

  it('never binds the whole element for a member of a non-struct array', () => {
    // A struct array whose metadata has not arrived yet looks the same.
    const s = scope({ index: 1, arrayKey: 'PLC:Motors', item: { Speed: 5 } });
    expect(resolveRepeatItem({ member: 'Speed' }, s, META)).toBe(5);
    const action = { type: 'writeDataVariable', target: { $repeatItem: { member: 'Speed' } } };
    const out = substituteRepeatRefs(action, s, META) as { target: unknown };
    expect(writeTargetAddress(out.target)).toBeNull();
  });

  it('falls back to the element value when the element folder is unknown', () => {
    const s = scope({
      index: 9,
      arrayKey: 'PLC:Motors',
      structArray: true,
      item: { Speed: 12 },
    });
    expect(resolveRepeatItem({ member: 'Speed' }, s, META)).toBe(12);
  });

  it('reads a member path of a non-variable element, records as JSON', () => {
    const s = scope({ item: { data: [{ value: 3 }], meta: { a: 1 } } });
    expect(resolveRepeatItem({ member: 'data/0/value' }, s, {})).toBe(3);
    expect(resolveRepeatItem({ member: 'meta' }, s, {})).toBe('{"a":1}');
    expect(resolveRepeatItem({ member: 'missing' }, s, {})).toBeNull();
  });
});

describe('substituteRepeatRefs', () => {
  it('leaves values without repeat references untouched, by identity', () => {
    const value = { text: { $var: { path: 'PLC:A' } }, list: [1, 2] };
    expect(containsRepeatRef(value)).toBe(false);
    expect(substituteRepeatRefs(value, scope({}), {})).toBe(value);
  });

  it('rewrites nested references and keeps untouched siblings', () => {
    const untouched = { $var: { path: 'PLC:B' } };
    const value = {
      $if: {
        condition: { $var: { path: 'PLC:Flags', repeatIndex: true } },
        true: { $repeatItem: { field: 'index' } },
        false: untouched,
      },
    };
    const out = substituteRepeatRefs(value, scope({ index: 3 }), {}) as typeof value;
    expect(out.$if.condition).toEqual({ $var: { path: 'PLC:Flags', index: 3 } });
    expect(out.$if.true).toBe(3);
    expect(out.$if.false).toBe(untouched);
  });

  it('turns a Repeat-item write target into the copy $var, or nothing to write', () => {
    const action = { type: 'toggleDataVariable', target: { $repeatItem: {} } };
    const [bound] = substituteRepeatRefs(
      [action],
      scope({ index: 1, arrayKey: 'PLC:Enables' }),
      {},
    ) as { target: unknown }[];
    expect(writeTargetAddress(bound.target)).toEqual({ datasource: 'PLC', path: 'Enables[1]' });
    const [readOnly] = substituteRepeatRefs([action], scope({ item: 'x' }), {}) as {
      target: unknown;
    }[];
    expect(writeTargetAddress(readOnly.target)).toBeNull();
  });
});

describe('a Repeat item inside a static icon', () => {
  const icon = { $static: { type: 'custom', path: { $repeatItem: { member: 'icon' } } } };
  const show = (sc: RepeatScopeValue) =>
    evaluatePropertyValue(substituteRepeatRefs(icon, sc, META), {});

  it('takes the path from an item of a list', () => {
    expect(show(scope({ item: { icon: 'icons/door.svg' } }))).toBe('/assets/icons/door.svg');
  });

  it('gives no icon for an element of a tag array, whose member is a variable', () => {
    const sc = scope({ index: 1, arrayKey: 'PLC:Motors', structArray: true });
    expect(show(sc)).toBeNull();
  });
});

describe('$repeatItem through an evaluation context', () => {
  it('evaluates to the concrete source the context resolves it to', () => {
    const ctx = {
      // Arrays reach `resolveVariable` at runtime even though its type says scalar.
      resolveVariable: (ds: string, path: string) =>
        (ds === 'PLC' && path === 'A' ? [7, 8] : null) as ResolvedValue,
      resolveRepeatItem: () => ({ $var: { path: 'PLC:A', index: 1 } }),
    };
    expect(evaluatePropertyValue({ $repeatItem: {} }, ctx)).toBe(8);
  });

  it('is absent outside a Repeater', () => {
    expect(evaluatePropertyValue({ $repeatItem: {} }, {})).toBeNull();
  });

  it('reads a $var at the context repeat index', () => {
    const ctx = { resolveVariable: () => ['x', 'y'] as unknown as ResolvedValue, repeatIndex: 1 };
    expect(evaluatePropertyValue({ $var: { path: 'PLC:A', repeatIndex: true } }, ctx)).toBe('y');
  });
});
