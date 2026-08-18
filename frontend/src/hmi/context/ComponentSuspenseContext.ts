import { createContext, useContext } from 'react';

/**
 * Whether a `$component:` instance provides its own Suspense boundary while the
 * shared ComponentRenderer chunk loads.
 *
 * Default `true`: each instance wraps itself in a silent `fallback={null}`
 * boundary so chrome (header/footer/sidebars), dialogs and page header/footer
 * pop in without flashing a spinner and without escalating to the app-level
 * page spinner.
 *
 * Page content sets this to `false` so its component instances skip the inner
 * boundary and let the surrounding content-area spinner handle the load — one
 * spinner over the page body instead of a red placeholder per component.
 */
export const ComponentSelfSuspenseContext = createContext(true);

export function useComponentSelfSuspense(): boolean {
  return useContext(ComponentSelfSuspenseContext);
}
