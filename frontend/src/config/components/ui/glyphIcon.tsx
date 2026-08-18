import type { SVGProps } from 'react';

/**
 * Shared wrapper for every hand-authored inline SVG glyph across the config UI
 * — property-source badges, action-type badges, and row action buttons
 * (edit/clear/expand/chevron). Not a general icon library (the HMI runtime has
 * one, `@shared/utils/phosphorIcons`) — these are freehand glyphs purpose-built
 * for this badge system. 16×16 viewBox, stroke-based, `currentColor` so each
 * glyph inherits its badge's color; `strokeWidth` defaults to 1.4 but callers
 * (e.g. the row-action icons) can override it via props.
 */
export default function GlyphIcon({ strokeWidth = 1.4, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="11"
      height="11"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    />
  );
}

/** Bound link — shared by the `$var` property-source badge and the
 *  `writeDataVariable` action-type badge (same glyph, same meaning). 24×24
 *  viewBox, from the property-panel design sandbox. */
export function LinkGlyphPaths() {
  return (
    <>
      <path d="M10 14a3.5 3.5 0 0 0 5 0l2.5-2.5a3.5 3.5 0 0 0-5-5L11 8" />
      <path d="M14 10a3.5 3.5 0 0 0-5 0l-2.5 2.5a3.5 3.5 0 0 0 5 5L13 16" />
    </>
  );
}

/** Globe — shared by the `$languages` property-source badge and the
 *  `setLanguage` action-type badge. */
export function GlobeGlyphPaths() {
  return (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M2.5 8 h11 M8 2.5 a9 9 0 0 1 0 11 a9 9 0 0 1 0 -11" />
    </>
  );
}
