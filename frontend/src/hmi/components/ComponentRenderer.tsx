import type { HmiWidgetProps, WidgetConfig } from '@shared/types/config';
import type { ComponentPropertySchema } from '@shared/types/componentProperty';
import { memo, useContext, useMemo } from 'react';
import { useComponentStore, selectComponentById } from '@shared/store/componentStore';
import { InputScopeContext } from '../context/InputScopeContext';
import { ComponentSlotContext } from '../context/ComponentSlotContext';
import { DefinitionScopeContext } from '../context/DefinitionScopeContext';
import { PreviewContext } from '@shared/context/PreviewContext';
import { collectSlotKeys, groupChildrenBySlot } from './ComponentSlot/slotKey';
import { SELF_LAYOUT_KEYS } from './layoutUtils';
import WidgetRenderer from './WidgetRenderer';

interface ComponentRendererProps extends HmiWidgetProps {
  _widgetId: string;
}

function ComponentRenderer({
  _widgetId,
  properties,
  layout,
  childConfigs,
}: ComponentRendererProps) {
  const isPreview = useContext(PreviewContext);
  const components = useComponentStore((s) => s.components);
  const savedComponent = selectComponentById(components, _widgetId);
  const draftComponent = useComponentStore((s) => s.draftComponents[_widgetId]);

  const component = isPreview ? (draftComponent ?? savedComponent) : savedComponent;

  const declared = component?.componentProperties;
  const contextValue = useMemo(
    () => ({ properties: withDeclaredDefaults(properties, declared) }),
    [properties, declared],
  );

  // Derived from the definition in hand rather than the widget registry, so the
  // components editor's draft picks up a slot the moment it is added.
  const definitionChildren = component?.children as WidgetConfig[] | undefined;
  const slotContent = useMemo(
    () => groupChildrenBySlot(childConfigs, collectSlotKeys(definitionChildren)),
    [childConfigs, definitionChildren],
  );
  // `withInstanceSizing` mints a fresh root node and layout, which would
  // invalidate `useResolvedLayout`'s memo on every render of the instance.
  const roots = useMemo(
    () =>
      definitionChildren?.map((child, index) =>
        index === 0 ? withInstanceSizing(child, layout) : child,
      ),
    [definitionChildren, layout],
  );

  if (!component || !roots) {
    return <div className="hmi-unknown-widget">Component not found: {_widgetId}</div>;
  }

  return (
    <InputScopeContext.Provider value={contextValue}>
      <ComponentSlotContext.Provider value={slotContent}>
        <DefinitionScopeContext.Provider value={true}>
          {roots.map((child) => (
            <WidgetRenderer key={child.id} node={child} />
          ))}
        </DefinitionScopeContext.Provider>
      </ComponentSlotContext.Provider>
    </InputScopeContext.Provider>
  );
}

/**
 * Fill in the declared default for every property the instance left unset.
 *
 * Without this a default is a lie: the properties panel prints it as the field's
 * `· default` hint and the components editor's preview mocks it in, while the
 * real page resolves `$componentProp` to nothing and the widget reading it
 * renders blank.
 *
 * `null` is a set value (an author clearing a field on purpose), so only
 * `undefined` falls through to the default.
 */
function withDeclaredDefaults(
  properties: Record<string, unknown> | undefined,
  declared: Record<string, ComponentPropertySchema> | undefined,
): Record<string, unknown> {
  const merged = { ...(properties ?? {}) };
  for (const [key, schema] of Object.entries(declared ?? {})) {
    if (merged[key] === undefined && schema?.defaultValue !== undefined) {
      merged[key] = schema.defaultValue;
    }
  }
  return merged;
}

/**
 * Fold the instance's own sizing onto the definition's first root node.
 *
 * The instance is a widget in its parent's layout, so `grow`, `basis`, `width`
 * and friends set on the `$component:` node have to reach the DOM — otherwise an
 * author sizing an instance in the editor sees nothing happen. They are merged
 * onto the root rather than applied to a wrapper element: a wrapper re-parents
 * the roots into a box of its own, so flex properties authored against a row
 * parent start resolving against a column and a `basis: 0` root collapses to
 * zero height.
 *
 * Only the first root takes them. A definition with several roots renders as
 * several siblings, and folding onto each would multiply the instance's sizing
 * by their count — `width: 300px` becoming N boxes of 300px, `margin` counted N
 * times — a total the author never asked for.
 *
 * Only the self-sizing half of the layout is taken. Direction, gap, padding and
 * the rest describe the component's insides, which belong to the definition.
 */
function withInstanceSizing(node: WidgetConfig, layout: HmiWidgetProps['layout']): WidgetConfig {
  if (!layout) return node;
  const overrides: Record<string, unknown> = {};
  for (const key of SELF_LAYOUT_KEYS) {
    const value = (layout as Record<string, unknown>)[key];
    if (value !== undefined) overrides[key] = value;
  }
  if (Object.keys(overrides).length === 0) return node;
  return { ...node, layout: { ...node.layout, ...overrides } };
}

// Memoised: a component instance re-renders only when its own `_widgetId` /
// input `properties` change (or its draft/definition in the store), not when a
// parent WidgetRenderer re-renders for an unrelated live-variable tick. The
// instance's inner widgets subscribe to their own variables, so live values
// still flow without re-running the whole subtree.
export default memo(ComponentRenderer);
