import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeAnchorStyle } from './anchorPosition';

// A 150×44 trigger in a 1280×800 viewport; GAP 6, MARGIN 8.
const at = (top: number, left = 569) => ({
  top,
  bottom: top + 44,
  left,
  right: left + 150,
  width: 150,
  height: 44,
});
const panel = { width: 346, height: 400 };

describe('computeAnchorStyle', () => {
  beforeEach(() => {
    vi.stubGlobal('innerWidth', 1280);
    vi.stubGlobal('innerHeight', 800);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('places the panel on the asked side when it fits', () => {
    expect(computeAnchorStyle(at(50), 'trigger-below', panel)).toMatchObject({ top: 100 });
    expect(computeAnchorStyle(at(465), 'trigger-above', panel)).toMatchObject({ top: 59 });
  });

  it('flips to the other side when only that side fits', () => {
    // Below a trigger at 465–509 the panel would end at 915; above it ends at 459.
    expect(computeAnchorStyle(at(465), 'trigger-below', panel)).toMatchObject({ top: 59 });
    expect(computeAnchorStyle(at(50), 'trigger-above', panel)).toMatchObject({ top: 100 });
    expect(computeAnchorStyle(at(300, 1000), 'trigger-right', panel)).toMatchObject({
      left: 1000 - 6 - 346,
    });
    expect(computeAnchorStyle(at(300, 100), 'trigger-left', panel)).toMatchObject({
      left: 256,
    });
  });

  it('clamps into the viewport when neither side fits', () => {
    // 600 tall: no room above (300) or below (450), so it stays below, pulled up to fit.
    expect(computeAnchorStyle(at(300), 'trigger-below', { width: 346, height: 600 })).toMatchObject(
      { top: 800 - 600 - 8 },
    );
  });
});
