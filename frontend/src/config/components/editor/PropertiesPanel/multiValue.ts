import type { LayoutConfig, WidgetConfig } from '@shared/types/config';
import { getPropertySource, type PropertySource } from '../propertyValueUtils';

/**
 * What a multi-selection currently holds for one property: the shared value, or a
 * marker that the widgets disagree.
 *
 * "Mixed" is deliberately distinct from "unset": a widget with no value and a widget
 * explicitly set to the schema default serialize differently and drift apart the day
 * the default changes, so they count as mixed.
 */
export type MultiValue =
  | { state: 'same'; value: unknown }
  /** `source` is null when the widgets disagree on the property source too. */
  | { state: 'mixed'; source: PropertySource | null };

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function compare(values: unknown[]): MultiValue {
  const [first, ...rest] = values;
  if (rest.every((v) => sameValue(first, v))) return { state: 'same', value: first };

  const sources = values.map((v) => getPropertySource(v) as PropertySource);
  const shared = sources.every((s) => s === sources[0]) ? sources[0] : null;
  return { state: 'mixed', source: shared };
}

export function multiValueOf(comps: WidgetConfig[], key: string): MultiValue {
  return compare(comps.map((comp) => comp.properties?.[key]));
}

export function multiLayoutValueOf(comps: WidgetConfig[], key: keyof LayoutConfig): MultiValue {
  return compare(comps.map((comp) => comp.layout?.[key]));
}

/**
 * Layout keys the selected widgets disagree on, mapped to the source they still
 * share — `LayoutFields`' `mixedLayout`. Every key the widgets carry is examined,
 * so a field the panel does not render simply never gets looked up.
 */
export function mixedLayoutMap(
  comps: WidgetConfig[],
): Map<keyof LayoutConfig, PropertySource | null> {
  const keys = new Set<keyof LayoutConfig>();
  for (const comp of comps) {
    for (const key of Object.keys(comp.layout ?? {})) keys.add(key as keyof LayoutConfig);
  }

  const mixed = new Map<keyof LayoutConfig, PropertySource | null>();
  for (const key of keys) {
    const value = multiLayoutValueOf(comps, key);
    if (value.state === 'mixed') mixed.set(key, value.source);
  }
  return mixed;
}
