import { createContext, useContext } from 'react';
import type { ExportedProperty } from '@shared/types/widgetSchema';

/**
 * Describes a component on the same page/dialog as the currently selected component.
 * Provides the list of properties it exports for use by the $widgetProp expression.
 */
export interface ComponentOption {
  id: string;
  name: string;
  type: string;
  exportedProperties: ExportedProperty[];
  /** Candidate field names for this component's struct exports, offered as
   *  datalist suggestions when binding a single field of a `$widgetProp` struct. */
  structFields?: string[];
}

/**
 * React context that provides the list of sibling components (same page/dialog)
 * that export properties accessible via $widgetProp.
 *
 * Provided by PropertiesPanel whenever a component is selected.
 * Consumed by ComponentPropEditor inside PropertySourceEditor.
 */
export const WidgetOptionsContext = createContext<ComponentOption[]>([]);

export function useComponentOptions(): ComponentOption[] {
  return useContext(WidgetOptionsContext);
}
