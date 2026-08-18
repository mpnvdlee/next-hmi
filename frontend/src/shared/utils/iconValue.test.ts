import { describe, expect, it } from 'vitest';
import { iconValueLabel, isIconValue } from './iconValue';

describe('isIconValue', () => {
  it('accepts only the canonical structured shapes', () => {
    expect(isIconValue({ type: 'builtin', name: 'gauge' })).toBe(true);
    expect(isIconValue({ type: 'custom', path: 'icons/gauge.svg' })).toBe(true);

    expect(isIconValue('gauge')).toBe(false);
    expect(isIconValue({ type: 'builtin', name: '' })).toBe(false);
    expect(isIconValue({ type: 'builtin', name: 'gauge', legacy: true })).toBe(false);
    expect(isIconValue({ type: 'custom', name: 'gauge' })).toBe(false);
  });
});

describe('iconValueLabel', () => {
  it('uses the built-in id or custom filename', () => {
    expect(iconValueLabel({ type: 'builtin', name: 'gauge' })).toBe('gauge');
    expect(iconValueLabel({ type: 'custom', path: 'icons/process/gauge.svg' })).toBe('gauge.svg');
  });
});
