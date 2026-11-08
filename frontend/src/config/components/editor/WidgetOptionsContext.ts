import { createContext, useContext } from 'react';
import type { ExportedProperty } from '@shared/types/widgetSchema';
import type { WidgetConfig } from '@shared/types/config';
import { widgetRegistry } from '@hmi/registry/widgetRegistry';
import { flattenComponents } from '@shared/utils/widgetTree';

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
 * Provided by PropertiesPanel whenever a component is selected, and by the
 * components editor for the widgets of the open definition.
 * Consumed by ComponentPropEditor inside PropertySourceEditor.
 */
export const WidgetOptionsContext = createContext<ComponentOption[]>([]);

export function useComponentOptions(): ComponentOption[] {
  return useContext(WidgetOptionsContext);
}

/** Candidate struct-field keys for a component's struct exports, taken from a
 *  `columns` property (the grid convention: each column's `value` is a row
 *  field). These populate the field tree under a `Struct` export. */
function deriveStructFields(properties: Record<string, unknown> | undefined): string[] {
  const columns = properties?.columns;
  if (!Array.isArray(columns)) return [];
  const fields: string[] = [];
  for (const col of columns) {
    const rec = col && typeof col === 'object' ? (col as Record<string, unknown>) : undefined;
    // A Data Grid column names its field `member`.
    const value = rec?.member ?? rec?.value;
    if (typeof value === 'string' && value && !fields.includes(value)) fields.push(value);
  }
  return fields;
}

/** Every widget under `containerComps` that exports a property. */
export function buildComponentOptions(containerComps: WidgetConfig[]): ComponentOption[] {
  return flattenComponents(containerComps).flatMap((c) => {
    const entry = widgetRegistry[c.type];
    if (!entry?.exportedProperties?.length) return [];
    return [
      {
        id: c.id,
        name: c.name,
        type: c.type,
        exportedProperties: entry.exportedProperties,
        structFields: deriveStructFields(c.properties),
      },
    ];
  });
}
