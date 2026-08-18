import type { WidgetModule } from '../src/shared/utils/widgetModuleLoader';

/**
 * Test-time stand-in for `@shared/utils/widgetModuleLoader`, wired up by the
 * `resolve.alias['@shared/utils/widgetModuleLoader']` entry in vitest.config.ts.
 *
 * The registry fetches `/stdlib-js/<Group>/<Name>/index.js` (plus a `?t=`
 * cache-buster) from a served build. jsdom has no such server, so resolve the
 * same key from the widget's TSX source instead.
 *
 * Aliasing rather than a mutable setter on the production module keeps the
 * test seam out of the shipped bundle: nothing in `src/` can reach in and swap
 * the loader, and no test has to remember to install one.
 *
 * The glob is lazy on purpose. An eager one would transform all 34 widget
 * sources for every test file that touches the registry, including the ones
 * that never render a stdlib widget.
 */
const sources = import.meta.glob('./**/index.tsx') as Record<string, () => Promise<WidgetModule>>;

export function loadWidgetModule(url: string): Promise<WidgetModule> {
  const key = new URL(url, 'http://localhost').pathname.replace(/^.*\/stdlib-js\//, '');
  const load = sources[`./${key.replace(/\.js$/, '.tsx')}`];
  if (!load) return Promise.reject(new Error(`no stdlib widget source for "${url}"`));
  return load();
}
