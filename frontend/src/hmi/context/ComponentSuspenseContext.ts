import { createContext, useContext } from 'react';

/**
 * Whether a `$component:` instance provides its own Suspense boundary while the
 * shared ComponentRenderer chunk loads.
 *
 * Default `true`: each instance wraps itself in a silent `fallback={null}`
 * boundary so chrome (the page-group header/footer/sidebars) pops in without
 * flashing a spinner and without escalating to the app-level page spinner.
 *
 * A page's own sections set this to `false` so their component instances skip
 * the inner boundary and let the surrounding content-area spinner handle that
 * one shared chunk — one spinner over the page body instead of a red
 * placeholder per component. Custom widget modules are not covered by this:
 * they keep their own boundary everywhere (see `registerCustomWidget`), since
 * one of them loading late must never blank the page body around it.
 */
export const ComponentSelfSuspenseContext = createContext(true);

export function useComponentSelfSuspense(): boolean {
  return useContext(ComponentSelfSuspenseContext);
}
