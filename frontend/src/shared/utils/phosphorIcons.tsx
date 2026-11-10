import type { LazyExoticComponent } from 'react';
import type { Icon } from '@phosphor-icons/react';
import { BUILTIN_ICON_IDS } from '@shared/config/iconAllowlist';
import { getBasePath, withBase } from '@shared/utils/runtimeBase';
import { settledLazy } from '@shared/utils/settledLazy';

export type IconComponent = LazyExoticComponent<Icon>;

// Per-icon lazy wrappers, cached by id so repeated calls return the same
// component reference (a fresh `lazy()` per render would remount/re-suspend
// forever). `phosphorIconComponents.tsx` (all 130 builtin icons, ~94 kB gzip as
// the `vendor-icons` chunk) is fetched by the dynamic import below only once a
// widget actually renders a builtin icon, so routes that render none don't pay
// for the whole set. Callers must render the returned component under a `<Suspense>`
// boundary (the page-level one in PageGroupPageView covers HMI widgets; a
// local `fallback={null}` boundary wraps the icon slot itself so an
// unresolved icon doesn't blank surrounding content — see Icon, Button,
// MenuToggleButton, NavigationMenu).
//
// Editor authoring surfaces (WidgetIcon, IconSourcePicker) need the full set
// rendered synchronously without per-tile Suspense flicker and import
// `phosphorIconComponents.tsx`'s map directly instead of going through this
// module — the editor route already reaches `@phosphor-icons/react` eagerly
// via its own UI-chrome icons, so nothing is saved by deferring there, but a
// lot of picker/tree UX would be lost.
const lazyIconCache: Record<string, IconComponent> = {};

// Once the icon chunk is in, every icon — including one mounting for the first
// time — renders without suspending (see settledLazy).
let iconComponents: Record<string, Icon> | undefined;
let iconChunk: Promise<Record<string, Icon>> | null = null;

function loadIconComponents(): Promise<Record<string, Icon>> {
  return (iconChunk ??= import('./phosphorIconComponents').then(
    (mod) => (iconComponents = mod.BUILTIN_ICON_COMPONENTS),
    (err) => {
      iconChunk = null;
      throw err;
    },
  ));
}

function loadLazyIcon(iconId: string): IconComponent {
  const cached = lazyIconCache[iconId];
  if (cached) return cached;
  const LazyIcon = settledLazy(
    () => iconComponents?.[iconId],
    () => loadIconComponents().then((icons) => icons[iconId]),
  ) as IconComponent;
  lazyIconCache[iconId] = LazyIcon;
  return LazyIcon;
}

export function isBuiltinIconId(value: string): boolean {
  return BUILTIN_ICON_IDS.has(value);
}

export function getBuiltinIconComponent(iconId: string): IconComponent | null {
  return BUILTIN_ICON_IDS.has(iconId) ? loadLazyIcon(iconId) : null;
}

// `?` and `#` start a query or hash and `\` reads as `/` to a URL parser. `"`
// and control characters are out too: a value that passes is written verbatim
// into a CSS `url("…")`.
const UNSAFE_PATH_CHARS = /[?#\\"\p{Cc}]/u;

function hasDotSegment(path: string): boolean {
  return path.split('/').some((segment) => segment === '.' || segment === '..');
}

/**
 * Whether an icon value is a `.svg` file inside the project's icons folder —
 * the logical `/assets/icons/…` or the same under the document's base, such as
 * `/runtime/<slug>/assets/icons/…`. Every custom icon URL passes here before
 * the page loads it. An icon field can be bound to a variable anyone on the
 * network may write, so a prefix match is not enough: `../` (also
 * percent-encoded), an encoded `/` or `\`, a query or a hash could reach any
 * other URL on this origin. The page loads `withBase(value)`.
 */
export function isCustomIconAssetPath(value: string): boolean {
  // Root-relative only: a CSS url() resolves a relative one against the
  // stylesheet rather than the page.
  if (!value.startsWith('/') || value.startsWith('//') || UNSAFE_PATH_CHARS.test(value)) {
    return false;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return false;
  }
  if (
    hasDotSegment(value) ||
    hasDotSegment(decoded) ||
    decoded.includes('\\') ||
    decoded.split('/').length !== value.split('/').length
  ) {
    return false;
  }
  const url = new URL(withBase(value), window.location.origin);
  return (
    url.origin === window.location.origin &&
    url.pathname.startsWith(`${getBasePath()}assets/icons/`) &&
    /\.svg$/i.test(url.pathname)
  );
}
