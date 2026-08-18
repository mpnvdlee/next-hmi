import { describe, expect, it } from 'vitest';
import {
  autoMarkerLabel,
  clamp01,
  defaultPositionForIndex,
  ensurePositionsForChildren,
  indexPositions,
  pruneOrphanPositions,
  resolveMarkerLabel,
} from './positions';
import type { ChildPosition, WidgetConfig } from '@shared/types/config';

const child = (id: string): WidgetConfig => ({
  id,
  type: 'Container',
  name: id,
});

describe('autoMarkerLabel', () => {
  it('maps 0–25 to A–Z', () => {
    expect(autoMarkerLabel(0)).toBe('A');
    expect(autoMarkerLabel(25)).toBe('Z');
  });

  it('rolls over to AA after Z', () => {
    expect(autoMarkerLabel(26)).toBe('AA');
    expect(autoMarkerLabel(27)).toBe('AB');
  });

  it('returns empty string for negative index', () => {
    expect(autoMarkerLabel(-1)).toBe('');
  });
});

describe('resolveMarkerLabel', () => {
  it('uses manual label when non-empty', () => {
    expect(resolveMarkerLabel({ id: 'x', x: 0, y: 0, label: 'V1' }, 5)).toBe('V1');
  });

  it('falls back to auto-letter when label missing', () => {
    expect(resolveMarkerLabel({ id: 'x', x: 0, y: 0 }, 2)).toBe('C');
  });

  it('falls back to auto-letter when label is whitespace', () => {
    expect(resolveMarkerLabel({ id: 'x', x: 0, y: 0, label: '   ' }, 0)).toBe('A');
  });

  it('falls back to auto-letter when entry undefined', () => {
    expect(resolveMarkerLabel(undefined, 3)).toBe('D');
  });
});

describe('pruneOrphanPositions', () => {
  it('drops entries whose id is not in childConfigs', () => {
    const positions: ChildPosition[] = [
      { id: 'a', x: 0.1, y: 0.1 },
      { id: 'ghost', x: 0.5, y: 0.5 },
      { id: 'b', x: 0.9, y: 0.9 },
    ];
    const out = pruneOrphanPositions(positions, [child('a'), child('b')]);
    expect(out.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('returns the same reference when nothing is pruned', () => {
    const positions: ChildPosition[] = [{ id: 'a', x: 0, y: 0 }];
    const out = pruneOrphanPositions(positions, [child('a')]);
    expect(out).toBe(positions);
  });

  it('returns empty array when no children', () => {
    expect(pruneOrphanPositions([{ id: 'a', x: 0, y: 0 }], [])).toEqual([]);
  });

  it('handles undefined positions input', () => {
    expect(pruneOrphanPositions(undefined, [child('a')])).toEqual([]);
  });
});

describe('ensurePositionsForChildren', () => {
  it('keeps existing entries and appends defaults for new children', () => {
    const positions: ChildPosition[] = [{ id: 'a', x: 0.1, y: 0.2 }];
    const out = ensurePositionsForChildren(positions, [child('a'), child('b'), child('c')]);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ id: 'a', x: 0.1, y: 0.2 });
    expect(out.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns empty list when no children configured', () => {
    expect(ensurePositionsForChildren(undefined, undefined)).toEqual([]);
  });
});

describe('defaultPositionForIndex', () => {
  it('starts at the inset edge', () => {
    expect(defaultPositionForIndex(0)).toEqual({ x: 0.5 - 0.4, y: 0.5 - 0.4 });
  });

  it('cascades by 0.05 and wraps within 0.8 span', () => {
    const p1 = defaultPositionForIndex(1);
    expect(p1.x).toBeCloseTo(0.5 - 0.4 + 0.05);
    const wrapped = defaultPositionForIndex(16);
    // 16 * 0.05 = 0.8 → wraps to 0
    expect(wrapped.x).toBeCloseTo(0.5 - 0.4);
  });
});

describe('clamp01', () => {
  it.each([
    [-1, 0],
    [0, 0],
    [0.5, 0.5],
    [1, 1],
    [2, 1],
    [Number.NaN, 0.5],
  ])('clamps %s to %s', (input, expected) => {
    expect(clamp01(input)).toBe(expected);
  });
});

describe('indexPositions', () => {
  it('builds a lookup map keyed by child id', () => {
    const positions: ChildPosition[] = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 1, y: 1 },
    ];
    const map = indexPositions(positions);
    expect(map.get('a')?.x).toBe(0);
    expect(map.get('b')?.y).toBe(1);
    expect(map.size).toBe(2);
  });

  it('returns empty map for undefined input', () => {
    expect(indexPositions(undefined).size).toBe(0);
  });
});
