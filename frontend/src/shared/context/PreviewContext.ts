import { createContext } from 'react';

/**
 * PreviewContext — when true, ComponentRenderer wraps each node in a
 * `<div data-widget-id="...">` so the preview bridge can apply
 * its selection class via postMessage without touching HMI components.
 */
export const PreviewContext = createContext(false);
