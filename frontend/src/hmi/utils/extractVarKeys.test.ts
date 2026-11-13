import { extractLiveKeys, extractVarKeys, usesBranch } from './extractVarKeys';

const v = (path: string, index?: number) => ({
  $var: index === undefined ? { path } : { path, index },
});

describe('extractVarKeys', () => {
  it('returns empty for primitives and non-var objects', () => {
    expect(extractVarKeys(undefined)).toEqual([]);
    expect(extractVarKeys(null)).toEqual([]);
    expect(extractVarKeys('MyPLC:Motor/Speed')).toEqual([]);
    expect(extractVarKeys(42)).toEqual([]);
    expect(extractVarKeys({ $static: { type: 'builtin', name: 'wave' } })).toEqual([]);
  });

  it('collects a top-level $var binding path', () => {
    expect(extractVarKeys(v('MyPLC:Motor/Speed'))).toEqual(['MyPLC:Motor/Speed']);
  });

  it('collects a $var even when it carries an array index', () => {
    expect(extractVarKeys(v('MyPLC:Arr', 2))).toEqual(['MyPLC:Arr']);
  });

  it('walks a property bag with mixed static and $var values', () => {
    const props = {
      label: { $static: 'hi' },
      value: v('PLC:a'),
      color: v('PLC:b'),
    };
    expect(extractVarKeys(props).slice().sort()).toEqual(['PLC:a', 'PLC:b']);
  });

  it('finds $var nested inside $if / $switch / $compare / $stringExpr', () => {
    const nested = {
      $if: {
        condition: { $compare: { left: v('PLC:cond'), op: '>', right: 3 } },
        true: v('PLC:whenTrue'),
        false: {
          $switch: {
            value: v('PLC:sw'),
            cases: [{ when: 1, then: v('PLC:caseA') }],
            default: { $stringExpr: { template: '{x}', vars: { x: v('PLC:tmpl') } } },
          },
        },
      },
    };
    expect(extractVarKeys(nested).slice().sort()).toEqual([
      'PLC:caseA',
      'PLC:cond',
      'PLC:sw',
      'PLC:tmpl',
      'PLC:whenTrue',
    ]);
  });

  it('finds $var inside every $and / $or item', () => {
    const value = { $and: [v('PLC:ready'), { $or: [{ $not: { value: v('PLC:fault') } }, true] }] };
    expect(extractVarKeys(value).slice().sort()).toEqual(['PLC:fault', 'PLC:ready']);
  });

  it('de-duplicates repeated keys', () => {
    expect(extractVarKeys({ a: v('PLC:x'), b: v('PLC:x') })).toEqual(['PLC:x']);
  });

  it('ignores malformed $var wrappers (no path)', () => {
    expect(extractVarKeys({ $var: { index: 1 } })).toEqual([]);
  });

  it('returns a stable reference for the same input object (memoised)', () => {
    const props = { value: v('PLC:a') };
    expect(extractVarKeys(props)).toBe(extractVarKeys(props));
  });
});

describe('usesBranch', () => {
  it('finds a $if or $switch at any depth, even one reading no variable', () => {
    expect(usesBranch({ $if: { condition: true, true: { $componentProp: 'a' } } })).toBe(true);
    expect(
      usesBranch({ $stringExpr: { template: '{1}', wildcards: { 1: { $switch: { value: 1 } } } } }),
    ).toBe(true);
    expect(usesBranch({ $stringExpr: { template: '{1}', wildcards: { 1: v('PLC:a') } } })).toBe(
      false,
    );
    expect(usesBranch(v('PLC:a'))).toBe(false);
  });
});

describe('extractLiveKeys', () => {
  const structMeta = { type: { kind: 'struct', name: 'Motor', array: true, fields: ['Speed'] } };
  // An array counting from 1; each element folder names its position from 0.
  const varMeta = {
    'PLC:Motors': structMeta,
    'PLC:Motors/Line[1]': { ...structMeta, position: 0 },
    'PLC:Motors/Line[1]/Speed': { type: { kind: 'scalar', base: 'Float', array: false } },
    'PLC:Motors/Line[2]': { ...structMeta, position: 1 },
    'PLC:Motors/Line[2]/Speed': { type: { kind: 'scalar', base: 'Float', array: false } },
  };

  it('adds the element key of a struct array bound at a literal index, by position', () => {
    const props = { a: v('PLC:Motors', 1), b: v('PLC:Other') };
    // Position 1 is the second element — Line[2] on an array that counts from 1.
    expect(extractLiveKeys(props, varMeta)).toEqual([
      'PLC:Motors',
      'PLC:Other',
      'PLC:Motors/Line[2]',
    ]);
  });

  it('returns the plain keys when nothing is indexed, and memoises per metadata', () => {
    const props = { a: v('PLC:Motors') };
    expect(extractLiveKeys(props, varMeta)).toBe(extractVarKeys(props));
    const indexed = { a: v('PLC:Motors', 0) };
    expect(extractLiveKeys(indexed, varMeta)).toBe(extractLiveKeys(indexed, varMeta));
    // A scalar array has no element keys to add.
    expect(extractLiveKeys({ a: v('PLC:Zones', 3) }, varMeta)).toEqual(['PLC:Zones']);
  });

  it('adds the element at the position a page metadata names, whatever its rank there', () => {
    const partial = {
      'PLC:Motors': structMeta,
      'PLC:Motors/Line[6]': { ...structMeta, position: 5 },
    };
    expect(extractLiveKeys({ a: v('PLC:Motors', 5) }, partial)).toEqual([
      'PLC:Motors',
      'PLC:Motors/Line[6]',
    ]);
  });

  it('keeps the very key list across new metadata naming the same element', () => {
    const indexed = { a: v('PLC:Motors', 1) };
    const first = extractLiveKeys(indexed, { ...varMeta });
    expect(first).toEqual(['PLC:Motors', 'PLC:Motors/Line[2]']);
    expect(extractLiveKeys(indexed, { ...varMeta })).toBe(first);
  });

  it('keeps the very key list of a scalar array bound at an index across new metadata', () => {
    const props = { a: v('PLC:Zones', 3) };
    const zones = { type: { kind: 'scalar', base: 'Integer', array: true } };
    expect(extractLiveKeys(props, { 'PLC:Zones': zones })).toBe(extractVarKeys(props));
    expect(extractLiveKeys(props, { 'PLC:Zones': zones })).toBe(extractVarKeys(props));
  });
});
