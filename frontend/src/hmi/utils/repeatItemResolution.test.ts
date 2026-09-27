import type { RepeatScopeValue } from '../context/RepeatScopeContext';
import { evaluatePropertyValue, type ResolvedValue } from './propertySourceEval';
import {
  containsRepeatRef,
  resolveRepeatItem,
  structElementPath,
  substituteRepeatRefs,
} from './repeatItemResolution';
import { writeTargetAddress } from '@shared/types/config';

function scope(patch: Partial<RepeatScopeValue>): RepeatScopeValue {
  return { index: 0, item: undefined, key: 'r#0', first: true, ...patch };
}

const META = {
  'PLC:Motors': {},
  'PLC:Motors/Line[0]/Speed': {},
  'PLC:Motors/Line[1]/Speed': {},
  'PLC:Motors/Line[1]/Name': {},
  'PLC:MotorsExtra/[1]/Speed': {},
};

describe('structElementPath', () => {
  it('finds the element folder by the index its name ends in', () => {
    expect(structElementPath(META, 'PLC:Motors', 1)).toBe('PLC:Motors/Line[1]');
  });

  it('does not match an array whose name merely starts the same', () => {
    expect(structElementPath(META, 'PLC:Motors', 5)).toBeUndefined();
    expect(structElementPath(META, 'PLC:MotorsExtra', 1)).toBe('PLC:MotorsExtra/[1]');
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

  it('binds a struct member to its leaf variable', () => {
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
