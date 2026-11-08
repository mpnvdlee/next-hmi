import { describe, expect, it } from 'vitest';
import { formatNumber, toDecimalComma } from './formatNumber';

describe('formatNumber', () => {
  it('writes a decimal comma and no thousands separator', () => {
    expect(formatNumber(1234.5)).toBe('1234,5');
    expect(formatNumber(-1234.5, 2)).toBe('-1234,50');
    expect(formatNumber(87.25, 0)).toBe('87');
    expect(formatNumber(12)).toBe('12');
  });

  it('clamps the decimals a binding delivers and shows --- for no number', () => {
    expect(formatNumber(1.23456789, 99)).toBe('1,234568');
    expect(formatNumber(1.5, -3)).toBe('2');
    expect(formatNumber(Number.NaN, 1)).toBe('---');
  });
});

describe('toDecimalComma', () => {
  it('swaps the decimal point and a grouping comma', () => {
    expect(toDecimalComma('41,280.5')).toBe('41.280,5');
    expect(toDecimalComma('+6.0')).toBe('+6,0');
  });
});
