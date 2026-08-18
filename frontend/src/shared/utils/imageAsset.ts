import { withBase } from './runtimeBase';

/**
 * Build a workspace asset URL from an image path. Bare filenames get an
 * `images/` prefix; paths that already start with `images/` are passed through.
 */
export function imageAssetUrl(path: string): string {
  return withBase(path.startsWith('images/') ? `/assets/${path}` : `/assets/images/${path}`);
}

/**
 * Resolve the body of an image value (e.g. `{ path: 'logo.png' }`) to a
 * full asset URL. Returns null when no usable path is present.
 */
export function imageBodyToUrl(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const path = (body as Record<string, unknown>).path;
  return typeof path === 'string' && path ? imageAssetUrl(path) : null;
}

/**
 * Resolve the raw value of an `src`/`image`-shaped property to a URL.
 * Accepts plain strings (already-resolved URLs) and `{ $static: { path } }`
 * wrappers used by schema-typed image fields.
 */
export function resolveImageSrc(src: unknown): string | null {
  if (!src) return null;
  if (typeof src === 'string' && src.length > 0) return src;
  if (typeof src === 'object' && src !== null) {
    return imageBodyToUrl((src as { $static?: unknown }).$static);
  }
  return null;
}
