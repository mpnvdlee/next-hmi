// The descriptions and icons the cards below render are the stdlib manifest's
// editor half, and importing this is what puts them on the registry entries.
// Side-effect import from the surface that reads them, so the palette is whole
// wherever it is built — the drawer, and the generated-catalog drift test.
import '@hmi/registry/stdlibEditorMetadata';
import {
  BUILTIN_WIDGET_TYPES,
  DEFAULT_COMPONENT_CATEGORY,
  DEFAULT_WIDGET_CATEGORY,
  resolveWidgetMetadata,
  widgetRegistry,
} from '@hmi/registry/widgetRegistry';
import { matchesSearchWords } from '@shared/utils/search';
import type { IconValue } from '@shared/types/config';

export interface CatalogItem {
  type: string;
  name: string;
  description?: string;
  icon: IconValue;
  category: string;
  /** Product-shipped (compiled-in or stdlib), as opposed to a project's own
   *  custom widget or reusable component. Drives the card badge. */
  builtin: boolean;
  /** A reusable component definition rather than a widget. Drives the card badge. */
  component: boolean;
}

interface CatalogCategory {
  category: string;
  items: CatalogItem[];
}

/** Built-in categories, in the order the selector shows them. Other declared
 * categories follow (sorted), then Components and the Other catch-all. */
export const CATEGORY_ORDER = [
  'Layout & structure',
  'Content & controls',
  'Inputs',
  'Indicators',
  'Navigation',
] as const;

/**
 * Group every registered widget into ordered categories for the selector drawer.
 * Every registry entry has a canonical category.
 */
export function buildCatalog(filter?: (type: string) => boolean): CatalogCategory[] {
  const byCategory = new Map<string, CatalogItem[]>();

  for (const type of Object.keys(widgetRegistry)) {
    if (filter && !filter(type)) continue;
    const metadata = resolveWidgetMetadata(type);
    const category = metadata.category;
    const item: CatalogItem = {
      type,
      name: metadata.name,
      description: metadata.description,
      icon: metadata.icon,
      category,
      builtin: BUILTIN_WIDGET_TYPES.has(type),
      component: type.startsWith('$component:'),
    };
    const bucket = byCategory.get(category);
    if (bucket) bucket.push(item);
    else byCategory.set(category, [item]);
  }

  const ordered: CatalogCategory[] = [];
  const emit = (cat: string) => {
    const items = byCategory.get(cat);
    if (items && items.length) ordered.push({ category: cat, items });
    byCategory.delete(cat);
  };

  for (const cat of CATEGORY_ORDER) emit(cat);

  const trailing = [DEFAULT_COMPONENT_CATEGORY, DEFAULT_WIDGET_CATEGORY];
  const middle = [...byCategory.keys()].filter((c) => !trailing.includes(c)).sort();
  for (const cat of middle) emit(cat);
  for (const cat of trailing) emit(cat);

  return ordered;
}

/** Case-insensitive all-word match on category, name, type and description. */
export function itemMatches(item: CatalogItem, query: string): boolean {
  return matchesSearchWords(query, [item.category, item.name, item.type, item.description]);
}
