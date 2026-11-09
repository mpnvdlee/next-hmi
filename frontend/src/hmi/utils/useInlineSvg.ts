import { useState, useEffect } from 'react';
import { isCustomIconAssetPath } from '@shared/utils/phosphorIcons';
import { withBase } from '@shared/utils/runtimeBase';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * What an icon draws with. Anything else goes with its subtree: `script`,
 * `foreignObject` (an HTML island), `a` and the animation elements (which can
 * turn a link into script), `image` and the filter primitives (outside loads).
 */
const ICON_ELEMENTS = new Set([
  'svg',
  'g',
  'defs',
  'symbol',
  'use',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'title',
  'desc',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
  'pattern',
  'marker',
  'style',
]);

/**
 * A reference out of the icon, in an attribute or in CSS: a url() that is not a
 * `#fragment`, an @import, image(), image-set() or src() that can name a URL
 * as a plain string, or a backslash, since a CSS escape can spell `url(` unseen.
 */
const OUTSIDE_REF = /\\|@import|url\(\s*(?!['"]?\s*#)|image(?:-set)?\(|src\(/i;

function isIconElement(node: Element): boolean {
  return (
    ICON_ELEMENTS.has(node.localName) &&
    node.prefix === null &&
    (node.namespaceURI === SVG_NS || node.namespaceURI === null) &&
    !(node.localName === 'style' && OUTSIDE_REF.test(node.textContent ?? ''))
  );
}

function cleanElement(el: Element): void {
  for (const attr of [...el.attributes]) {
    const name = attr.localName.toLowerCase();
    if (
      name.startsWith('on') ||
      (name === 'href' && !attr.value.startsWith('#')) ||
      OUTSIDE_REF.test(attr.value)
    ) {
      el.removeAttributeNode(attr);
    }
  }
  for (const child of [...el.childNodes]) {
    if (child instanceof Element) {
      if (isIconElement(child)) cleanElement(child);
      else child.remove();
    } else if (child.nodeType === Node.CDATA_SECTION_NODE) {
      child.replaceWith(child.textContent ?? '');
    } else if (child.nodeType !== Node.TEXT_NODE) {
      // Comments and processing instructions do not reach the HTML parser
      // intact: `<!-->` ends an HTML comment at once and the first `>` ends a
      // PI, so whatever followed would be parsed as markup.
      child.remove();
    }
  }
}

/**
 * Parse an SVG file as XML and keep only icon elements and their harmless
 * attributes. The result reaches the HTML parser through innerHTML; the XML
 * serializer escapes text and attribute values, and nothing is left that the
 * HTML parser reads differently.
 */
function sanitizeSvg(text: string): string {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.localName !== 'svg' || !isIconElement(root) || doc.querySelector('parsererror')) {
    return '';
  }
  cleanElement(root);
  return new XMLSerializer().serializeToString(root);
}

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
  let svg = svgText;
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

/**
 * Forget every cached icon. An asset rewritten in place keeps its URL, so the
 * only way to see the new file is to forget the old one; icons already on
 * screen keep what they show, the next mount fetches again. The editor calls
 * this when another writer changed an asset — the live view does not, it
 * shows a change after a browser reload.
 */
export function forgetInlineSvgs(): void {
  resolved.clear();
  pending.clear();
}

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
        const clean = sanitizeSvg(text);
        const svg = clean && recolorSvg(clean);
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
 * Fetches a custom icon, sanitises it and repoints its colours at
 * `currentColor`, so the icon inherits CSS `color` from its parent, and returns
 * the markup ready for dangerouslySetInnerHTML. Fills stay fills and strokes
 * stay strokes — only the colours change, so outline icons keep their outlines.
 * A value that is not a custom icon path is never fetched.
 */
export function useInlineSvg(value: string | null | undefined): string {
  const url = value && isCustomIconAssetPath(value) ? value : null;
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
