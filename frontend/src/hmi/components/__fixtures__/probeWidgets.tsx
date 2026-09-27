import type { HmiWidgetProps } from '@shared/types/config';
import type { RegistryEntry } from '@shared/types/widgetSchema';

/**
 * Stand-ins for real built-in widgets in suites that mock the registry.
 *
 * A real built-in is a lazy module jsdom cannot fetch, and the shim that would
 * load one cannot be imported at module scope without pulling in the real
 * registry and defeating the very mock these entries feed. Defined once so the
 * three suites that need a widget to point at do not each carry their own copy
 * that has to be edited when `RegistryEntry` gains a field.
 */

/** Renders nothing but a marked div — for asserting on the wrapper around it. */
export const GateProbe: RegistryEntry = {
  name: 'Gate Probe',
  category: 'Test',
  component: () => <div className="hmi-gate-probe" />,
  schema: {},
};

/** Renders its `label` as a button, so a test has an accessible name to find.
 *  `value` is declared because the binding overlay only harvests variables out
 *  of properties the schema knows about (see `isRenderedProperty`). */
export const LabeledProbe: RegistryEntry = {
  name: 'Labeled Probe',
  category: 'Test',
  component: ({ properties }: HmiWidgetProps) => (
    <button type="button">{String(properties?.label ?? '')}</button>
  ),
  schema: { value: { type: 'string', label: 'Value' } },
};

/** Throws on render, for the error-boundary path. */
export const ThrowingWidget: RegistryEntry = {
  name: 'Throwing Widget',
  category: 'Test',
  component: () => {
    throw new Error('boom');
  },
  schema: {},
};
