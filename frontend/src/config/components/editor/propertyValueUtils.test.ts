import { propertyValuePreview, getPropertySource, getStaticString } from './propertyValueUtils';

describe('propertyValuePreview', () => {
  it('previews a static value', () => {
    expect(propertyValuePreview('hello')).toBe('hello');
    expect(propertyValuePreview(null)).toBe('—');
    expect(propertyValuePreview(true, 'boolean')).toBe('true');
  });

  it('previews a $var binding', () => {
    expect(propertyValuePreview({ $var: { path: 'ds:tag' } })).toBe('ds: tag');
    expect(propertyValuePreview({ $var: { path: 'ds:tag', index: 2 } })).toBe('ds: tag[2]');
  });

  it('recursively previews a one-level $if', () => {
    const value = {
      $if: {
        condition: { $var: { path: 'ds:running' } },
        true: 'On',
        false: 'Off',
      },
    };
    expect(propertyValuePreview(value)).toBe('if(ds: running then On else Off)');
  });

  it('recursively previews a nested $if inside $if up to the depth cap', () => {
    const inner = {
      $if: {
        condition: { $var: { path: 'ds:b' } },
        true: 'Inner-true',
        false: 'Inner-false',
      },
    };
    const outer = {
      $if: {
        condition: { $var: { path: 'ds:a' } },
        true: inner,
        false: 'Outer-false',
      },
    };
    // outer expands (depth 0), inner expands one more level (depth 1) — still
    // within the 2-level cap, so both branches render fully.
    expect(propertyValuePreview(outer)).toBe(
      'if(ds: a then if(ds: b then Inner-true else Inner-false) else Outer-false)',
    );
  });

  it('stubs a branch nested beyond the depth cap as kind(…)', () => {
    const level3 = { $compare: { left: { $var: { path: 'ds:c' } }, operator: '>', right: 0 } };
    const level2 = { $if: { condition: level3, true: 'T', false: 'F' } };
    const level1 = { $if: { condition: { $var: { path: 'ds:a' } }, true: level2, false: 'F0' } };
    // level1 = depth 0, level2 = depth 1 (still expands), level3 sits at depth 2
    // for the *condition* of level2 — which is itself evaluated at depth 2 and
    // thus stubbed.
    expect(propertyValuePreview(level1)).toBe(
      'if(ds: a then if(compare(…) then T else F) else F0)',
    );
  });

  it('previews $switch recursively into each case and the default, capped at depth', () => {
    const value = {
      $switch: {
        value: { $var: { path: 'ds:mode' } },
        cases: [
          { when: 1, then: 'One' },
          { when: 2, then: 'Two' },
        ],
        default: 'Other',
      },
    };
    expect(propertyValuePreview(value)).toBe('switch(ds: mode: "1" → One, "2" → Two, else Other)');
  });

  it('previews $compare', () => {
    const value = { $compare: { left: { $var: { path: 'ds:x' } }, operator: '>=', right: 10 } };
    expect(propertyValuePreview(value)).toBe('compare(ds: x >= 10)');
  });

  it('falls back to a kind(…) stub for unrecognized wrappers', () => {
    expect(propertyValuePreview({ $recipeListZZZ: {} } as unknown)).toBe('$recipeListZZZ(…)');
  });
});

describe('getPropertySource', () => {
  it('detects static and wrapped modes', () => {
    expect(getPropertySource(undefined)).toBe('static');
    expect(getPropertySource('plain')).toBe('static');
    expect(getPropertySource({ $var: { path: '' } })).toBe('$var');
  });
});

describe('getStaticString', () => {
  it('unwraps $static and stringifies primitives', () => {
    expect(getStaticString({ $static: 'x' })).toBe('x');
    expect(getStaticString(5)).toBe('5');
    expect(getStaticString(null, 'fallback')).toBe('fallback');
  });
});
