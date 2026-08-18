import type { SchemaField } from '@shared/types/widgetSchema';
import { primaryType } from '@shared/utils/valueTypes';

/** The section ungrouped fields fall into — what every schema rendered as
 *  before `SchemaField.group` existed. */
export const DEFAULT_SCHEMA_GROUP = 'Properties';

export interface SchemaGroup {
  title: string;
  keys: string[];
}

/**
 * Partition a widget schema into the properties panel's sections.
 *
 * Sections come out in the order their first field is declared, and every field
 * without a `group` lands in one "Properties" section — so a schema that
 * declares no groups (every custom widget, and every built-in that has not been
 * grouped yet) renders exactly one flat list, as it always did.
 *
 * `widgets` fields are dropped: a slot's content is the instance's own children,
 * edited in the widget tree and the preview, so the panel — which shows property
 * values — has nothing to show for one. A group left with no other field drops
 * with it rather than rendering an empty section.
 */
export function groupSchemaKeys(schema: Record<string, SchemaField>): SchemaGroup[] {
  const groups: SchemaGroup[] = [];
  const byTitle = new Map<string, SchemaGroup>();

  for (const key of Object.keys(schema)) {
    if (primaryType(schema[key].type).toLowerCase() === 'widgets') continue;
    const title = schema[key].group || DEFAULT_SCHEMA_GROUP;
    let group = byTitle.get(title);
    if (!group) {
      group = { title, keys: [] };
      byTitle.set(title, group);
      groups.push(group);
    }
    group.keys.push(key);
  }

  return groups;
}
