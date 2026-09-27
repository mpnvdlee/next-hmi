/**
 * Alignment glyphs for the Layout panel's Align and Distribute rows. Raw SVG
 * strings, same conventions as {@link directionIcons} (16×16, `currentColor`).
 *
 * Each glyph draws three children arranged the way the option arranges them, so
 * the arrangement itself is what is being chosen. Authored once along the
 * horizontal and transposed for the vertical. Nothing draws the container edge —
 * the glyph runs nearly the full viewBox and the button border reads as it.
 */

import { OPEN } from './directionIcons';

/** `[x, y, width, height]`, in the 16×16 viewBox. */
type Rect = [number, number, number, number];

/** The edges a child sits flush against: all but a hairline of the viewBox, so
 *  the arrangement is measured against the button border. */
const MIN = 0.5;
const MAX = 15.5;
const SPAN = MAX - MIN;

function svg(rects: Rect[], vertical: boolean): string {
  const body = rects
    .map(([x, y, w, h]) =>
      vertical
        ? `<rect x="${y}" y="${x}" width="${h}" height="${w}" rx="0.9"/>`
        : `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="0.9"/>`,
    )
    .join('');
  return `${OPEN}${body}</svg>`;
}

/** Main-axis child thickness and packed gap. Slimmest of the three rows: the
 *  clump travels `SPAN - 3 * MAIN - 2 * MAIN_GAP`, so thickness spent here is
 *  travel lost, and travel is what tells `flex-start` from `flex-end`. */
const MAIN = 2.4;
const MAIN_GAP = 1.2;

/** Extent across the axis the option does not move a child on. The direction
 *  glyphs' 13, so both rows draw children of one size; not the full 15, which is
 *  what `align: stretch` means. */
const MAIN_LENGTH = 13;

/** Where the three children sit along the axis the option distributes them on —
 *  the actual CSS layouts, which is what keeps `space-between` and
 *  `space-around` apart. */
function packing(): Record<string, number[]> {
  const clump = 3 * MAIN + 2 * MAIN_GAP;
  const step = MAIN + MAIN_GAP;
  const packed = (start: number) => [start, start + step, start + 2 * step];
  const share = SPAN / 3;
  return {
    'flex-start': packed(MIN),
    center: packed(MIN + (SPAN - clump) / 2),
    'flex-end': packed(MIN + (SPAN - clump)),
    'space-between': [MIN, MIN + (SPAN - MAIN) / 2, MAX - MAIN],
    'space-around': [0, 1, 2].map((i) => MIN + i * share + (share - MAIN) / 2),
  };
}

/** Three different extents, so the edge they line up on is what the eye sees;
 *  three equal blocks read as the same glyph three times. */
const EXTENTS = [12.5, 7, 10];

/** Cross-axis thickness and gap. Wider than {@link MAIN} — nothing travels on
 *  this axis, so the room goes into reading the ragged extents. */
const CROSS = 2.8;
const CROSS_GAP = 2;

/** Evenly spread along the axis this row does not decide — that one is
 *  `justify-content`'s. */
function spread(): number[] {
  const start = (16 - (3 * CROSS + 2 * CROSS_GAP)) / 2;
  const step = CROSS + CROSS_GAP;
  return [start, start + step, start + 2 * step];
}

/** Where a child of `extent` starts, for each cross-axis option. */
const CROSS_OFFSET: Record<string, (extent: number) => number> = {
  'flex-start': () => MIN,
  center: (extent) => 8 - extent / 2,
  'flex-end': (extent) => MAX - extent,
  stretch: () => MIN,
};

/**
 * `justify-content` glyphs: three children packed against one end of the main
 * axis, or spread along it. Authored along the horizontal, transposed for a
 * `column`.
 *
 * @param axisVertical - the main axis runs top-to-bottom (a `column` container).
 */
export function justifyIcons(axisVertical: boolean): Record<string, string> {
  const offset = (16 - MAIN_LENGTH) / 2;
  const out: Record<string, string> = {};
  for (const [value, positions] of Object.entries(packing())) {
    out[value] = svg(
      positions.map((pos) => [pos, offset, MAIN, MAIN_LENGTH] as Rect),
      axisVertical,
    );
  }
  return out;
}

/**
 * `align-items` glyphs: three children parked at one end of the cross axis, or
 * stretched across it. Authored along the vertical, hence the flag inverted on
 * the way to {@link svg}.
 *
 * @param axisVertical - the cross axis runs top-to-bottom (a `row` container).
 */
export function alignIcons(axisVertical: boolean): Record<string, string> {
  const positions = spread();
  const out: Record<string, string> = {};
  for (const [value, offsetOf] of Object.entries(CROSS_OFFSET)) {
    const stretch = value === 'stretch';
    out[value] = svg(
      positions.map((pos, i) => {
        const extent = stretch ? SPAN : EXTENTS[i];
        return [pos, offsetOf(extent), CROSS, extent] as Rect;
      }),
      !axisVertical,
    );
  }
  return out;
}
