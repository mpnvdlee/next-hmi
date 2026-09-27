import { useState, useEffect } from 'react';
import { withBase } from '@shared/utils/runtimeBase';
import { subscribeConfigChanged } from '@shared/events/configChangedBus';

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

// Recoloured markup per URL for the rest of the page load. Icons remount on
// every page switch, and without this each remount paid a fetch and painted one
// frame without its icon. `resolved` is what a first render can read
// synchronously; `pending` shares one fetch between icons mounting together.
const resolved = new Map<string, string>();
const pending = new Map<string, Promise<string>>();

// An asset rewritten in place keeps its URL, so the only way to see the new
// file is to forget the old one. Icons already on screen keep what they show;
// the next mount fetches again.
subscribeConfigChanged((event) => {
  if (event.artifact_type !== 'asset') return;
  resolved.clear();
  pending.clear();
});

function loadInlineSvg(url: string): Promise<string> {
  const hit = resolved.get(url);
  if (hit !== undefined) return Promise.resolve(hit);
  let load = pending.get(url);
  if (!load) {
    load = fetch(withBase(url))
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${url}`);
        return r.text();
      })
      .then((text) => {
        const svg = recolorSvg(text);
        resolved.set(url, svg);
        return svg;
      })
      .finally(() => pending.delete(url));
    pending.set(url, load);
  }
  return load;
}

function cachedSvg(url: string | null | undefined): string {
  return url ? (resolved.get(url) ?? '') : '';
}

/**
 * Fetches an SVG from a URL and repoints its colours at `currentColor`, so the
 * icon inherits CSS `color` from its parent, and returns the markup ready for
 * dangerouslySetInnerHTML. Fills stay fills and strokes stay strokes — only the
 * colours change, so outline icons keep their outlines.
 */
export function useInlineSvg(url: string | null | undefined): string {
  const [shown, setShown] = useState(() => ({ url, svg: cachedSvg(url) }));
  // Reset during render rather than from an effect, so a changed URL never
  // gets a frame of the previous icon.
  if (shown.url !== url) setShown({ url, svg: cachedSvg(url) });

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    loadInlineSvg(url).then(
      (svg) => {
        if (!cancelled) setShown((s) => (s.url === url && s.svg === svg ? s : { url, svg }));
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [url]);

  return shown.url === url ? shown.svg : cachedSvg(url);
}
