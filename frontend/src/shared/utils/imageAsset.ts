import { withBase } from './runtimeBase';

/** The asset-root folders a stored path may already carry. A path rooted at one
 *  of them is a complete workspace path and must not be prefixed again. */
const ASSET_ROOTS = ['images/', 'icons/', 'videos/'];

const ABSOLUTE_URL = /^(?:https?:\/\/|data:|blob:)/i;

/** True for a path an author typed as a URL rather than a workspace asset path.
 *  Shared so every asset field agrees on what counts as already-absolute. */
export function isAbsoluteUrl(path: string): boolean {
  return ABSOLUTE_URL.test(path);
}

/**
 * Build a workspace asset URL from a stored asset path.
 *
 * A path already rooted at a known asset folder (`images/`, `icons/`,
 * `videos/`) resolves under `/assets/` unchanged, and an absolute URL
 * (`http(s)://`, `data:`, `blob:`) is returned exactly as given — an author may
 * type either into an asset field. Only a bare filename gets the `images/`
 * prefix, which is what image values stored before the folder was part of the
 * path still look like.
 */
export function imageAssetUrl(path: string): string {
  if (ABSOLUTE_URL.test(path)) return path;
  const rooted = ASSET_ROOTS.some((root) => path.startsWith(root));
  return withBase(rooted ? `/assets/${path}` : `/assets/images/${path}`);
}

/**
 * Resolve an asset-field value to something `<img src>`/`<video src>` can load.
 *
 * A `$static` payload is already a full `/assets/…` url by the time it reaches
 * a widget, but a `$var` or `$urlParam` on the same field delivers the stored
 * path verbatim — and a project-relative `images/logo.png` in `src` resolves
 * against the *page* url, not the asset root. Anything already absolute, rooted
 * or remote is the author's own spelling and passes through.
 *
 * Unlike `imageAssetUrl`, a bare filename is left alone rather than assumed to
 * be an image: this runs on fields that may hold a video or an icon.
 */
export function assetSrc(value: string): string {
  if (!value || value.startsWith('/') || ABSOLUTE_URL.test(value)) return value;
  return ASSET_ROOTS.some((root) => value.startsWith(root)) ? withBase(`/assets/${value}`) : value;
}

/**
 * Resolve the body of an asset value (e.g. `{ path: 'logo.png' }`,
 * `{ path: 'videos/clip.mp4' }`) to a full asset URL. Returns null when no
 * usable path is present.
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
