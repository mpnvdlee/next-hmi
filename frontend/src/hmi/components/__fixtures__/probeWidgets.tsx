// A test fixture: fast refresh never reloads it, so its view may sit beside the entries.
/* eslint-disable react-refresh/only-export-components */
import { bindingKey, type HmiWidgetProps } from '@shared/types/config';
import type { RegistryEntry } from '@shared/types/widgetSchema';
import { getVarBinding, isVarSource } from '@shared/types/propertyValueGuards';
import { useVariableStore } from '../../store/variableStore';
import { useBindingValue, useVariableMeta } from '../../hooks/useVariable';

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
 *  of properties the schema knows about (see `isRenderedProperty`). A bound
 *  label reads the store, so a Value input's local slot shows; the resolver
 *  hooks are not imported, since they pull in the registry this mocks. */
function LabeledProbeView({ properties }: HmiWidgetProps) {
  const label = properties?.label;
  const key = isVarSource(label) ? label.$var.path : undefined;
  const live = useVariableStore((s) => (key ? s.values[key] : undefined));
  return <button type="button">{String((key ? live : label) ?? '')}</button>;
}

export const LabeledProbe: RegistryEntry = {
  name: 'Labeled Probe',
  category: 'Test',
  component: LabeledProbeView,
  schema: { value: { type: 'string', label: 'Value' } },
};

/** Reads its `variable` as a project's own widget does — the value, and the
 *  metadata of `bindingKey` — and shows both as `value ≤ max`. */
function MetaProbeView({ properties }: HmiWidgetProps) {
  const binding = getVarBinding(properties?.variable);
  const value = useBindingValue(binding);
  const meta = useVariableMeta(bindingKey(binding));
  return <span>{`${String(value)} ≤ ${String(meta?.max)}`}</span>;
}

export const MetaProbe: RegistryEntry = {
  name: 'Meta Probe',
  category: 'Test',
  component: MetaProbeView,
  schema: { variable: { type: ['float', 'integer'], label: 'Variable', write: true } },
};

/** Each CountingProbe's renders so far, by widget id. */
export const renderCounts = new Map<string, number>();

/** Counts its renders and draws its children — for asserting which widgets a
 *  store update re-renders. */
export const CountingProbe: RegistryEntry = {
  name: 'Counting Probe',
  category: 'Test',
  component: ({ id = '', children }: HmiWidgetProps) => {
    renderCounts.set(id, (renderCounts.get(id) ?? 0) + 1);
    return <div>{children}</div>;
  },
  schema: {},
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
