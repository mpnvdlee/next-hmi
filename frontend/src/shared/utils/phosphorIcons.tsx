import { lazy, type LazyExoticComponent } from 'react';
import type { Icon } from '@phosphor-icons/react';
import { BUILTIN_ICON_IDS } from '@shared/config/iconAllowlist';
import { stripBase } from '@shared/utils/runtimeBase';

export type IconComponent = LazyExoticComponent<Icon>;

// Per-icon lazy wrappers, cached by id so repeated calls return the same
// component reference (a fresh `lazy()` per render would remount/re-suspend
// forever). Backlog item 22: `phosphorIconComponents.tsx` (all 130 builtin
// icons, ~94 kB gzip as the `vendor-icons` chunk) previously loaded as a
// static import reachable from every route via this module. HMI runtime
// consumers (Icon/Button/MenuToggleButton/NavigationMenu widgets, and the
// custom-widget SDK exposed by nextHmiSdk.ts) now only fetch it once a widget
// actually renders a builtin icon, via the dynamic import below, so routes
// that render no icons (or only a couple) don't pay for the whole set
// up front. Callers must render the returned component under a `<Suspense>`
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

function loadLazyIcon(iconId: string): IconComponent {
  const cached = lazyIconCache[iconId];
  if (cached) return cached;
  const LazyIcon = lazy(async () => {
    const { BUILTIN_ICON_COMPONENTS } = await import('./phosphorIconComponents');
    return { default: BUILTIN_ICON_COMPONENTS[iconId] };
  });
  lazyIconCache[iconId] = LazyIcon;
  return LazyIcon;
}

export function isBuiltinIconId(value: string): boolean {
  return BUILTIN_ICON_IDS.has(value);
}

export function getBuiltinIconComponent(iconId: string): IconComponent | null {
  return BUILTIN_ICON_IDS.has(iconId) ? loadLazyIcon(iconId) : null;
}

export function isCustomIconAssetPath(value: string): boolean {
  // Accept both logical (/assets/icons/…) and manager-prefix forms such as
  // /runtime/<slug>/assets/icons/… — custom icon resolution prefixes for
  // proxied instances.
  return stripBase(value).startsWith('/assets/icons/');
}
