import { describe, it, expect } from 'vitest';
import { toNumber } from './coercion';

describe('toNumber', () => {
  it('passes through finite numbers and rejects NaN', () => {
    expect(toNumber(42)).toBe(42);
    expect(toNumber(NaN)).toBeNull();
  });

  it('parses leading numerics from strings', () => {
    expect(toNumber('5')).toBe(5);
    expect(toNumber('3.14')).toBe(3.14);
    expect(toNumber('abc')).toBeNull();
  });

  it('maps booleans to 1 / 0 and null/undefined to null', () => {
    expect(toNumber(true)).toBe(1);
    expect(toNumber(false)).toBe(0);
    expect(toNumber(null)).toBeNull();
    expect(toNumber(undefined)).toBeNull();
  });
});
