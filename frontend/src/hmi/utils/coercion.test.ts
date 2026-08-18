import { describe, it, expect } from 'vitest';
import { coerceToBaseType, toNumber } from './coercion';

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

describe('coerceToBaseType', () => {
  it('keeps null/undefined absent', () => {
    expect(coerceToBaseType(null, 'string')).toBeUndefined();
    expect(coerceToBaseType(undefined, 'integer')).toBeUndefined();
  });

  it('interconverts integer and float (float→integer rounds)', () => {
    expect(coerceToBaseType(3.7, 'integer')).toBe(4);
    expect(coerceToBaseType(3, 'float')).toBe(3);
    expect(coerceToBaseType(-2.4, 'integer')).toBe(-2);
  });

  it('coerces string→number only when it parses cleanly', () => {
    expect(coerceToBaseType('42', 'integer')).toBe(42);
    expect(coerceToBaseType('3.14', 'float')).toBe(3.14);
    expect(coerceToBaseType('12px', 'float')).toBeUndefined();
    expect(coerceToBaseType('', 'integer')).toBeUndefined();
  });

  it('coerces number/boolean → string', () => {
    expect(coerceToBaseType(42, 'string')).toBe('42');
    expect(coerceToBaseType(true, 'string')).toBe('true');
    expect(coerceToBaseType(false, 'string')).toBe('false');
  });

  it('accepts only booleans for boolean fields', () => {
    expect(coerceToBaseType(true, 'boolean')).toBe(true);
    expect(coerceToBaseType('true', 'boolean')).toBeUndefined();
    expect(coerceToBaseType(1, 'boolean')).toBeUndefined();
  });

  it('treats datetime/date/time/color as a string channel', () => {
    expect(coerceToBaseType('2026-06-16', 'date')).toBe('2026-06-16');
    expect(coerceToBaseType('14:30:00', 'time')).toBe('14:30:00');
    expect(coerceToBaseType('#ff0000', 'color')).toBe('#ff0000');
    expect(coerceToBaseType(5, 'date')).toBe('5');
  });

  it('accepts a number (seconds) or string for duration', () => {
    expect(coerceToBaseType(5400, 'duration')).toBe(5400);
    expect(coerceToBaseType('PT1H30M', 'duration')).toBe('PT1H30M');
    expect(coerceToBaseType(true, 'duration')).toBeUndefined();
  });

  it('passes structured / unknown base types through unchanged', () => {
    const icon = { type: 'builtin', name: 'gauge' };
    expect(coerceToBaseType(icon, 'icon')).toBe(icon);
  });
});
