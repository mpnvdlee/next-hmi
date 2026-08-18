import { describe, it, expect } from 'vitest';
import { slugify, slugId } from './id';

describe('slugify', () => {
  it('produces lowercase kebab slugs', () => {
    expect(slugify('Value Display')).toBe('value-display');
    expect(slugify('  Tank #3 (top)  ')).toBe('tank-3-top');
    expect(slugify('Café Crème')).toBe('cafe-creme');
  });

  it('returns empty string for non-alphanumeric input', () => {
    expect(slugify('')).toBe('');
    expect(slugify('///')).toBe('');
  });
});

describe('slugId', () => {
  it('returns the bare slug when free', () => {
    expect(slugId('Home', [])).toBe('home');
  });

  it('appends an incrementing counter on collision', () => {
    const taken = new Set<string>();
    const a = slugId('Container', taken);
    taken.add(a);
    const b = slugId('Container', taken);
    taken.add(b);
    expect([a, b]).toEqual(['container', 'container-1']);
  });

  it('skips suffixes already taken', () => {
    expect(slugId('box', ['box', 'box-1'])).toBe('box-2');
  });

  it('falls back to "item" for empty bases', () => {
    expect(slugId('', [])).toBe('item');
  });
});
