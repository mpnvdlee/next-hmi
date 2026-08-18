import { useState, useEffect } from 'react';
import { withBase } from '@shared/utils/runtimeBase';

function stripSvgColors(svgText: string): string {
  const match = svgText.match(/<svg[\s\S]*<\/svg>/i);
  if (!match) return '';
  let svg = match[0];
  svg = svg
    .replace(/\sfill="[^"]*"/gi, '')
    .replace(/\sstroke="[^"]*"/gi, '')
    .replace(/\scolor="[^"]*"/gi, '');
  svg = svg.replace(
    /^(<svg\b[^>]*>)/i,
    '$1<style>*{fill:currentColor!important;stroke:none!important}</style>',
  );
  return svg;
}

/**
 * Fetches an SVG from a URL, strips all hardcoded fill/stroke colors, and
 * returns the cleaned SVG markup ready for dangerouslySetInnerHTML.
 * `currentColor` is injected so the icon inherits CSS `color` from its parent.
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
        if (!cancelled) setSvgContent(stripSvgColors(text));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [url]);

  return svgContent;
}
