import type { ChildPosition, WidgetConfig } from '@shared/types/config';

/**
 * Auto-letter assignment for a child index: A–Z, then AA, AB, AC, …
 * Excel-style. Pure function of (zero-based) tree index.
 */
export function autoMarkerLabel(index: number): string {
  if (index < 0) return '';
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/**
 * Resolve the displayed marker label for a child: user-set label when non-empty,
 * otherwise the auto-letter derived from tree-order index.
 */
export function resolveMarkerLabel(entry: ChildPosition | undefined, treeIndex: number): string {
  const manual = entry?.label?.trim();
  if (manual) return manual;
  return autoMarkerLabel(treeIndex);
}

/**
 * Drop position entries whose child id is no longer in the tree.
 * Returns the input array reference when nothing changes (so React can bail out).
 */
export function pruneOrphanPositions(
  positions: ChildPosition[] | undefined,
  childConfigs: WidgetConfig[] | undefined,
): ChildPosition[] {
  const list = Array.isArray(positions) ? positions : [];
  if (!childConfigs || childConfigs.length === 0) {
    return list.length === 0 ? list : [];
  }
  const known = new Set(childConfigs.map((c) => c.id));
  const filtered = list.filter((p) => known.has(p.id));
  return filtered.length === list.length ? list : filtered;
}

/** Clamp a normalized 0–1 coordinate. */
export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Default (x, y) for a newly added child not yet in `positions`.
 * Cascades diagonally through the inset 0.1–0.85 range so subsequent children
 * do not stack exactly; wraps after sixteen positions.
 */
export function defaultPositionForIndex(occupiedCount: number): { x: number; y: number } {
  const step = 0.05;
  const span = 0.8;
  const offset = (occupiedCount * step) % span;
  return { x: 0.5 + offset - span / 2, y: 0.5 + offset - span / 2 };
}

/**
 * Ensure every child in `childConfigs` has a corresponding position entry.
 * Missing entries are appended with a cascading default; existing entries kept as-is.
 * Output preserves entry order: existing first (in their array order),
 * then newcomers in tree order.
 */
export function ensurePositionsForChildren(
  positions: ChildPosition[] | undefined,
  childConfigs: WidgetConfig[] | undefined,
): ChildPosition[] {
  const list = Array.isArray(positions) ? [...positions] : [];
  if (!childConfigs || childConfigs.length === 0) return list;
  const have = new Set(list.map((p) => p.id));
  for (const c of childConfigs) {
    if (!have.has(c.id)) {
      const { x, y } = defaultPositionForIndex(list.length);
      list.push({ id: c.id, x, y });
      have.add(c.id);
    }
  }
  return list;
}

/** Build a lookup from child id → position entry. */
export function indexPositions(positions: ChildPosition[] | undefined): Map<string, ChildPosition> {
  const map = new Map<string, ChildPosition>();
  if (!Array.isArray(positions)) return map;
  for (const p of positions) map.set(p.id, p);
  return map;
}
