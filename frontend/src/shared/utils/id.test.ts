import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomUuid, slugify, slugId } from './id';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('randomUuid', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses crypto.randomUUID when the page is a secure context', () => {
    expect(randomUuid()).toMatch(UUID_V4);
  });

  it('falls back to getRandomValues when randomUUID is missing', () => {
    // What a plain-HTTP LAN install looks like: no secure context, so no randomUUID.
    vi.stubGlobal('crypto', {
      getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
    });
    const ids = new Set(Array.from({ length: 100 }, () => randomUuid()));
    for (const id of ids) expect(id).toMatch(UUID_V4);
    expect(ids.size).toBe(100);
  });

  it('falls back to Math.random with no Web Crypto at all', () => {
    vi.stubGlobal('crypto', undefined);
    const ids = new Set(Array.from({ length: 100 }, () => randomUuid()));
    for (const id of ids) expect(id).toMatch(UUID_V4);
    expect(ids.size).toBe(100);
  });
});

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
