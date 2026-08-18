import { createContext, useContext } from 'react';
import type { ComponentPropertySchema } from '@shared/types/componentProperty';

/**
 * Context that publishes the declared component-property schema of the current
 * widget or dialog being authored. Set by panels that own a component-property
 * scope (CompositionWidgetPanel for widget children, the Dialog branch in
 * PropertiesPanel for dialog children). Consumed by ComponentPropEditor inside
 * PropertySourceEditor to populate the `$componentProp` picker.
 */
interface ComponentPropertySchemaContextValue {
  properties: Record<string, ComponentPropertySchema>;
  /** When true (widget children), `$var` bindings are not offered — children
   *  must read values via `$componentProp`. Dialog children leave this false. */
  forbidVar?: boolean;
}

export const ComponentPropertySchemaContext =
  createContext<ComponentPropertySchemaContextValue | null>(null);

/** Returns the component-property schema if the editor is inside a widget/dialog scope, null otherwise. */
export function useComponentPropertySchema(): ComponentPropertySchemaContextValue | null {
  return useContext(ComponentPropertySchemaContext);
}
