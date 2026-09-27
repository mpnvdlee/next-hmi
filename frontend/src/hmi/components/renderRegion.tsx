import type { ReactNode } from 'react';
import type { WidgetConfig } from '@shared/types/config';
import { DefinitionScopeContext } from '../context/DefinitionScopeContext';
import WidgetRenderer from './WidgetRenderer';

export function renderRegionChildren(
  components: WidgetConfig[],
  fallback: ReactNode = null,
): ReactNode {
  if (components.length === 0) return fallback;
  return components.map((comp) => <WidgetRenderer key={comp.id} node={comp} />);
}

/**
 * Render one widget node — the SDK primitive behind a widget that places nodes
 * itself rather than taking the renderer's pre-rendered `children`.
 *
 * A widget reaches these nodes through `childConfigs` (its own children, when it
 * declares `hostsChildren`), through a `widgets`-typed property, or through
 * {@link renderSlotWidgets} for the ones a caller supplied. Exposed on
 * `window.__nextHMI__` so a built-in or project widget can lay children out at
 * positions of its own choosing.
 */
export function renderWidget(node: WidgetConfig): ReactNode {
  return <WidgetRenderer node={node} />;
}

/**
 * Render the widgets a *caller* put into one of an instance's slots.
 *
 * Like {@link renderRegionChildren}, minus the empty-case fallback and plus the
 * scope flag: slot content is authored by whoever placed the instance, not by
 * the definition rendering around it, so the editor must offer it for
 * selection. See
 * {@link DefinitionScopeContext} for why ids alone cannot tell the two apart.
 */
export function renderSlotWidgets(nodes: WidgetConfig[]): ReactNode {
  return (
    <DefinitionScopeContext.Provider value={false}>
      {nodes.map((node) => (
        <WidgetRenderer key={node.id} node={node} />
      ))}
    </DefinitionScopeContext.Provider>
  );
}
