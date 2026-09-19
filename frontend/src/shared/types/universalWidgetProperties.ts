/**
 * The properties every widget carries regardless of its schema — the two
 * visibility gates stamped onto every registry entry by `VISIBILITY_SCHEMA`.
 *
 * Declared here, in a leaf module, so the runtime can read the list without
 * importing the registry (which imports ComponentRenderer, which imports
 * WidgetRenderer, which imports the binding validator that needs it).
 *
 * Pinned three ways: `VISIBILITY_SCHEMA` builds exactly these keys,
 * `__fixtures__/universalWidgetPropertyKeys.json` is the cross-language copy,
 * and `backend/core/validation/structure.py::_UNIVERSAL_PROPERTY_KEYS` is the
 * server's. `widgetRegistry.test.ts` and `test_structure_parity.py` hold them
 * equal, so a gate property added to one is caught rather than silently
 * diverging.
 */
export const UNIVERSAL_PROPERTY_KEYS: ReadonlySet<string> = new Set(['visible', 'interactable']);

/**
 * Whether a property decides *whether* the widget renders rather than *what* it
 * shows. A variable read only by one of these is not something the viewer is
 * looking at, so a missing value in it must not put a mark on a widget that is
 * rendering correctly.
 */
export function isVisibilityGateProperty(key: string): boolean {
  return UNIVERSAL_PROPERTY_KEYS.has(key);
}
