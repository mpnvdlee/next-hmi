/**
 * Direction glyphs for the Layout panel's icon button group.
 *
 * `options[].icon` is a raw SVG **string** injected by `renderSchemaField`, not
 * a React component, so these cannot reuse `GlyphIcon`; they follow its
 * conventions instead (16×16 viewBox, `currentColor`). Each shows three children
 * in the flow the option means, rather than an arrow.
 */

/** 20, not `GlyphIcon`'s 11: these are diagrams, not badges, and only legible
 *  when the arrangement nearly fills its button. `.cfg-seg-btn` trims an icon
 *  option's horizontal padding to match, so the buttons keep their footprint. */
export const OPEN = '<svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor">';

/** A hair over the align glyphs' 2.8 and the distribute glyphs' 2.4, so all
 *  three Layout rows carry one weight. Those two cannot go heavier without
 *  losing their ragged extents and their travel. */
const BAR = 3;

/** Spanning nearly the full viewBox, like the align and distribute glyphs. */
const POSITIONS = [0.5, 0.5 + (15 - BAR) / 2, 15.5 - BAR];

const bars = (vertical: boolean) =>
  OPEN +
  POSITIONS.map((pos) =>
    vertical
      ? `<rect x="1.5" y="${pos}" width="13" height="${BAR}" rx="1"/>`
      : `<rect x="${pos}" y="1.5" width="${BAR}" height="13" rx="1"/>`,
  ).join('') +
  '</svg>';

/** Three bars side by side. */
export const ROW_ICON = bars(false);

/** Three bars stacked. */
export const COLUMN_ICON = bars(true);
