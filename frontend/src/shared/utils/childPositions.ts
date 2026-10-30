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
 * Default (x, y) for the child at `index` among the placeable children.
 * Row-major through an 8 × 8 grid inset to 0.1–0.8, so the first 64 children
 * each get a spot of their own; the 65th starts the grid over.
 */
export function defaultPositionForIndex(index: number): { x: number; y: number } {
  const cell = index % 64;
  return { x: 0.1 + (cell % 8) * 0.1, y: 0.1 + Math.floor(cell / 8) * 0.1 };
}

/**
 * Ensure every child in `childConfigs` has a corresponding position entry.
 * A missing entry gets its child's grid spot — the spot the ImageContainer
 * already draws it at while unplaced; existing entries are kept as-is.
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
  childConfigs.forEach((c, index) => {
    if (!have.has(c.id)) {
      const { x, y } = defaultPositionForIndex(index);
      list.push({ id: c.id, x, y });
      have.add(c.id);
    }
  });
  return list;
}

/**
 * A Repeater that places its copies at item x / y covers the whole image: it
 * has no position entry or marker of its own, though it still counts in the
 * tree order the marker letters follow. Mirrors the `fills` check in the
 * ImageContainer widget.
 */
export function fillsImage(child: WidgetConfig): boolean {
  const v = child.properties?.placement;
  const placement = v && typeof v === 'object' ? (v as { $static?: unknown }).$static : v;
  return child.type === 'Repeater' && placement === 'items';
}

/** Build a lookup from child id → position entry. */
export function indexPositions(positions: ChildPosition[] | undefined): Map<string, ChildPosition> {
  const map = new Map<string, ChildPosition>();
  if (!Array.isArray(positions)) return map;
  for (const p of positions) map.set(p.id, p);
  return map;
}
