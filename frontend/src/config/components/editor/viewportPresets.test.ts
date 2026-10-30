import { describe, expect, it } from 'vitest';
import type { EditorViewport } from '@shared/types/config';
import { CUSTOM_VIEWPORT, viewportFromShell, viewportToShell } from './viewportPresets';

describe('editor viewport in the project shell', () => {
  it('round-trips a preset and a custom size', () => {
    for (const choice of [
      { idx: 2, w: 1920, h: 1080 },
      { idx: CUSTOM_VIEWPORT, w: 1280, h: 800 },
    ]) {
      expect(viewportFromShell(viewportToShell(choice))).toEqual(choice);
    }
    expect(viewportToShell({ idx: 2, w: 1920, h: 1080 }).preset).toBe('tablet');
  });

  it('defaults to Fit when the project has none', () => {
    expect(viewportFromShell(undefined).idx).toBe(0);
  });

  it('falls back per field for a hand-edited value', () => {
    const edited = { preset: 'watch', width: 5, height: 'x' } as unknown as EditorViewport;
    expect(viewportFromShell(edited)).toEqual({ idx: 0, w: 200, h: 1080 });
  });
});
