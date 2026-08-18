import { describe, expect, it } from 'vitest';
import { usesTime } from './usesTime';

describe('usesTime', () => {
  it('returns false for primitives and time-free values', () => {
    expect(usesTime(null)).toBe(false);
    expect(usesTime('HH:mm')).toBe(false);
    expect(usesTime(42)).toBe(false);
    expect(usesTime({ text: { $static: 'hello' }, count: { $var: { path: 'ds:x' } } })).toBe(false);
  });

  it('detects a top-level $time wrapper', () => {
    expect(usesTime({ label: { $time: { format: 'HH:mm:ss' } } })).toBe(true);
  });

  it('detects $time nested inside other wrappers and arrays', () => {
    expect(
      usesTime({
        text: {
          $if: {
            cond: { $var: { path: 'ds:on' } },
            then: { $time: { format: 'HH:mm' } },
            else: { $static: '-' },
          },
        },
      }),
    ).toBe(true);
    expect(usesTime([{ $static: 1 }, { $time: {} }])).toBe(true);
  });

  it('memoises per object reference', () => {
    const value = { label: { $time: { format: 'HH:mm' } } };
    expect(usesTime(value)).toBe(true);
    // Same reference returns the cached result (exercises the WeakMap branch).
    expect(usesTime(value)).toBe(true);
  });
});
