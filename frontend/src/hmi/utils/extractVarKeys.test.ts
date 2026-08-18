import { extractVarKeys } from './extractVarKeys';

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
