import { useState, useEffect } from 'react';
import { withBase } from '@shared/utils/runtimeBase';

/** `fill="…"` / `stroke="…"` presentation attributes, not `fill-opacity` or `stroke-width`. */
const PAINT_ATTR = /\s(fill|stroke)="([^"]*)"/gi;
/** The same two properties as CSS declarations, inside a `style` attribute or a `<style>` block. */
const PAINT_DECL = /\b(fill|stroke)(\s*:\s*)([^;}"']+)/gi;

/**
 * A paint of `none` is geometry, not colour: it is what makes an outline icon
 * an outline rather than a silhouette, so it survives recolouring untouched.
 * Everything else becomes the colour inherited from the widget.
 */
function toCurrentColor(paint: string): string {
  const value = paint.trim().toLowerCase();
  return value === 'none' || value === 'transparent' ? value : 'currentColor';
}

function recolorSvg(svgText: string): string {
  const match = svgText.match(/<svg[\s\S]*<\/svg>/i);
  if (!match) return '';
  let svg = match[0];
  // A `color` attribute would resolve `currentColor` to the icon's own colour
  // instead of the widget's, so it goes rather than being repointed.
  svg = svg.replace(/\scolor="[^"]*"/gi, '');
  svg = svg.replace(PAINT_ATTR, (_m, prop, value) => ` ${prop}="${toCurrentColor(value)}"`);
  svg = svg.replace(
    PAINT_DECL,
    (_m, prop, separator, value) => `${prop}${separator}${toCurrentColor(value)}`,
  );
  // SVG's initial fill is black, so an icon that declares no paint at all needs
  // one on the root for its shapes to inherit. Added only when the root is
  // silent, so an explicit `fill="none"` root still governs its children.
  svg = svg.replace(/^<svg\b[^>]*>/i, (rootTag) =>
    /\sfill=/i.test(rootTag) ? rootTag : rootTag.replace(/(\/?)>$/, ' fill="currentColor"$1>'),
  );
  return svg;
}

/**
 * Fetches an SVG from a URL and repoints its colours at `currentColor`, so the
 * icon inherits CSS `color` from its parent, and returns the markup ready for
 * dangerouslySetInnerHTML. Fills stay fills and strokes stay strokes — only the
 * colours change, so outline icons keep their outlines.
 */
export function useInlineSvg(url: string | null | undefined): string {
  const [svgContent, setSvgContent] = useState('');

  useEffect(() => {
    if (!url) {
      setSvgContent('');
      return;
    }
    let cancelled = false;
    fetch(withBase(url))
      .then((r) => r.text())
      .then((text) => {
        if (!cancelled) setSvgContent(recolorSvg(text));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [url]);

  return svgContent;
}
