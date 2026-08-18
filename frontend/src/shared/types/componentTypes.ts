/**
 * Reusable component types — matches the backend ComponentDefinition model.
 *
 * The shared component-property primitives live in `./componentProperty`.
 */

import type { ComponentPropertySchema } from './componentProperty';
import type { IconValue } from './config';

/** A named, reusable widget composition with a component-property interface. */
export interface ComponentDefinition {
  id: string;
  name: string;
  /** Optional nested folder path. Derived from the component's on-disk location. */
  group?: string | null;
  /** One-line summary shown on the app-drawer card. */
  description?: string | null;
  /** Category shown in the app drawer, independent from the on-disk folder. */
  category?: string | null;
  /** Icon-picker value shown in the app drawer and page tree. */
  icon?: IconValue | null;
  /** Optional fixed preview width in the components editor, in pixels. */
  width?: number | null;
  /** Optional fixed preview height in the components editor, in pixels. */
  height?: number | null;
  componentProperties: Record<string, ComponentPropertySchema>;
  /** WidgetConfig-shaped nodes in the component's internal widget tree. */
  children: unknown[];
}
