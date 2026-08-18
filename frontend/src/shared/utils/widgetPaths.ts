import { withBase } from './runtimeBase';
import type { CustomWidgetManifestEntry } from '@shared/types/widgetSchema';

/** The manifest fields a widget's URLs are built from. Taking the entry rather
 *  than four positional optionals means a caller cannot silently omit `origin`
 *  and get a project URL for a stdlib widget, and the next field that affects a
 *  URL needs no signature change. */
export type WidgetLocation = Pick<
  CustomWidgetManifestEntry,
  'name' | 'group' | 'origin' | 'buildTs'
>;

/** Compiled modules and stylesheets are served from a different root depending on
 *  where the widget came from. Project widgets are compiled on load into the
 *  runtime-home cache and served from /widget-js/, with their stylesheets read
 *  straight from the project folder at /widgets/. Stdlib widgets are compiled at
 *  build time and ship with the frontend, both files together under /stdlib-js/.
 *
 *  All three are served by the *project instance*, so all three carry the base
 *  prefix when that instance is proxied under /runtime/<slug>/ or /editor/<slug>/
 *  (see runtimeBase.ts). Serving stdlib from the instance rather than the origin
 *  root is deliberate: Vite's dev server appends `?import` to every dynamic
 *  import — `@vite-ignore` suppresses the rewrite but not `__vite__injectQuery` —
 *  and 500s if it owns the path itself. Behind the same proxy hop /widget-js
 *  already takes, the query reaches a StaticFiles mount that ignores it.
 *
 *  `buildTs` is appended as a cache-buster so the browser picks up a recompiled
 *  file rather than its cached copy. */
function widgetPath(widget: WidgetLocation, root: string, file: string): string {
  const { name, group, buildTs } = widget;
  const base = withBase(group ? `${root}/${group}/${name}/${file}` : `${root}/${name}/${file}`);
  return buildTs ? `${base}?t=${encodeURIComponent(buildTs)}` : base;
}

/** Returns the JS module URL for a custom or stdlib widget */
export function getWidgetJsPath(widget: WidgetLocation): string {
  return widgetPath(widget, widget.origin === 'stdlib' ? '/stdlib-js' : '/widget-js', 'index.js');
}

/** Returns the CSS stylesheet URL for a custom or stdlib widget */
export function getWidgetStylePath(widget: WidgetLocation): string {
  return widgetPath(widget, widget.origin === 'stdlib' ? '/stdlib-js' : '/widgets', 'style.css');
}
