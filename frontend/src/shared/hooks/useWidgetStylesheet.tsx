import type { ComponentType } from 'react';
import { useStylesheet } from './useStylesheet';
import { getWidgetStylePath, type WidgetLocation } from '@shared/utils/widgetPaths';
import type { HmiWidgetProps } from '@shared/types/config';

/**
 * Wraps a component with stylesheet injection.
 * The returned component loads its CSS via `useStylesheet` on mount and
 * unloads it when the last instance unmounts (reference-counted).
 */
export function wrapComponentWithStylesheet(
  Comp: ComponentType<HmiWidgetProps>,
  widget: WidgetLocation,
): ComponentType<HmiWidgetProps> {
  // Loop-invariant: every input is fixed for the life of this wrapper, and a
  // recompile mints a new one through a fresh manifest entry.
  const href = getWidgetStylePath(widget);
  const Wrapped: ComponentType<HmiWidgetProps> = (props) => {
    useStylesheet(href);
    return <Comp {...props} />;
  };
  Wrapped.displayName = widget.name;
  return Wrapped;
}
