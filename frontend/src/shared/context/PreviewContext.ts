import { createContext, useContext } from 'react';

/**
 * PreviewContext — when true, ComponentRenderer wraps each node in a
 * `<div data-widget-id="...">` so the preview bridge can apply
 * its selection class via postMessage without touching HMI components.
 */
export const PreviewContext = createContext(false);

/** True while rendering inside the editor's preview pane rather than the
 *  operator runtime. A widget reads it to draw an authoring-only affordance —
 *  an outline around a hole the author is filling, say — which the operator
 *  must never see. Exposed on `window.__nextHMI__`. */
export function useIsPreview(): boolean {
  return useContext(PreviewContext);
}
