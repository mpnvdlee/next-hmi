import type { ReactNode } from 'react';
import { widgetRegistry } from '../registry/widgetRegistry';

/**
 * The zero-config navigation surface: a project whose left sidebar holds nothing
 * still gets a menu.
 *
 * Rendered straight from the registry rather than through `WidgetRenderer` —
 * there is no node in `config.json` to render, so there is nothing for the
 * editor to select, no binding to overlay and no property expression to
 * subscribe to. The registry entry is a built-in module, so it arrives with
 * the menu's own `Suspense` boundary and paints once that module lands.
 */
export default function FallbackNavigationMenu(): ReactNode {
  const Entry = widgetRegistry['NavigationMenu']?.component;
  return Entry ? <Entry /> : null;
}
