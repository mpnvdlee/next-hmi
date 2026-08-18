export type WidgetModule = { default?: unknown };

/**
 * Dynamic `import()` of a compiled widget module.
 *
 * The URL is a real served path (`/widget-js/…`, `/stdlib-js/…`) and must stay
 * `@vite-ignore`d so the bundler leaves it alone.
 *
 * Under Vitest this module is replaced wholesale — see
 * `resolve.alias['@shared/utils/widgetModuleLoader']` in vitest.config.ts,
 * which points it at `widgets/widgetModuleLoader.ts`.
 * jsdom has no such URL to fetch, so a test rendering a stdlib widget would
 * otherwise only ever see the Suspense fallback.
 */
export function loadWidgetModule(url: string): Promise<WidgetModule> {
  return import(/* @vite-ignore */ url);
}
