import { afterEach, describe, expect, it } from 'vitest';
import { CUSTOM_VIEWPORT, storeViewport, storedViewport } from './viewportPresets';

describe('stored viewport', () => {
  afterEach(() => window.localStorage.clear());

  it('round-trips a custom size', () => {
    storeViewport({ idx: CUSTOM_VIEWPORT, w: 1280, h: 800 });
    expect(storedViewport()).toEqual({ idx: CUSTOM_VIEWPORT, w: 1280, h: 800 });
  });

  it('clamps an out-of-range size', () => {
    storeViewport({ idx: CUSTOM_VIEWPORT, w: 5, h: 99999 });
    expect(storedViewport()).toEqual({ idx: CUSTOM_VIEWPORT, w: 200, h: 7680 });
  });

  it('falls back to Fit for a corrupt or unknown value', () => {
    window.localStorage.setItem('cfg-preview:viewport', '{not json');
    expect(storedViewport().idx).toBe(0);
    storeViewport({ idx: CUSTOM_VIEWPORT + 1, w: 800, h: 600 });
    expect(storedViewport().idx).toBe(0);
  });
});
