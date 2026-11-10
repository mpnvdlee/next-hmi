import { describe, expect, it } from 'vitest';
import { formatFingerprint } from './formatFingerprint';

describe('formatFingerprint', () => {
  it('writes a SHA-256 hex digest as sixteen groups of four', () => {
    const hex = '1d534d36ac8dffa9856077e4dac8cedf09d1ce37133e303bb0d6009e4add4049';
    expect(formatFingerprint(hex)).toBe(
      '1d53 4d36 ac8d ffa9 8560 77e4 dac8 cedf 09d1 ce37 133e 303b b0d6 009e 4add 4049',
    );
  });

  it('keeps a short tail and an empty value as they are', () => {
    expect(formatFingerprint('abcdef')).toBe('abcd ef');
    expect(formatFingerprint('')).toBe('');
  });
});
