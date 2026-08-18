import type { ReactNode } from 'react';
import type { FieldGroupTier } from '.';
import { PROPERTY_SOURCES } from '@hmi/utils/propertySourceRegistry';
import type { PropertySource } from '../../editor/propertyValueUtils';
import { CollapsedPreview, KindLabel } from '../../editor/PropertySourceEditor/editors/shared';

/**
 * The half of a source-backed field's `FieldGroup` that its current source
 * decides: a leaf source (`$static`, `$var`, …) renders inline as tier 1/2 with
 * no collapsed preview and no drawer, a composite one (`$if`, `$switch`, …) as
 * an expandable tier-3 box carrying a preview and the source's short name.
 *
 * Pass `source: null` for a field with no source at all — it boxes, previews and
 * gets a drawer, but shows no kind label.
 */
export function sourceFieldGroupProps({
  source,
  title,
  value,
  fieldType,
  mixed = false,
}: {
  source: PropertySource | null;
  title: string;
  value: unknown;
  fieldType: string;
  /** A multi-selection whose widgets disagree — there is no value to preview. */
  mixed?: boolean;
}): {
  tier: FieldGroupTier;
  summary: ReactNode;
  kindLabel: ReactNode;
  drawerTitle: string | undefined;
} {
  const entry = source ? PROPERTY_SOURCES[source] : undefined;
  const tier: FieldGroupTier = entry?.contentTier ?? 3;
  const boxed = tier === 3;

  return {
    tier,
    summary: boxed ? (
      mixed ? (
        <KindLabel>Mixed</KindLabel>
      ) : (
        <CollapsedPreview value={value} fieldType={fieldType} />
      )
    ) : undefined,
    kindLabel: boxed && entry ? <KindLabel>{entry.short ?? entry.label}</KindLabel> : undefined,
    drawerTitle: boxed ? title : undefined,
  };
}
