import { createContext } from 'react';

/**
 * True while rendering the widgets a reusable component's *definition* draws.
 *
 * Those widgets belong to the definition, not to the tree that placed the
 * instance, so the editor must not offer them for selection — clicking one
 * resolves outward to the instance. The widgets a caller dropped into the
 * instance's slots are the caller's, so `ComponentSlot` flips this back off
 * around them even though they render deeper.
 *
 * Ids alone cannot tell the two apart: they are per-tree slugs, so a definition
 * and a page mint `container` / `body` / `label` independently and collide.
 * `WidgetRenderer` turns this flag into a `data-widget-source="definition"`
 * marker on the preview wrapper, which is what the preview bridge reads.
 */
export const DefinitionScopeContext = createContext(false);
