/**
 * The properties every widget carries regardless of its schema — the visibility
 * gates `VISIBILITY_SCHEMA` stamps onto every registry entry. A leaf module, so
 * the runtime can read the list without importing the registry (which reaches
 * the binding validator that needs it).
 *
 * `widgetRegistry.test.ts` and `test_structure_parity.py` hold this equal to
 * `VISIBILITY_SCHEMA`, the JSON fixture, and
 * `validation/structure.py::_UNIVERSAL_PROPERTY_KEYS`.
 */
export const UNIVERSAL_PROPERTY_KEYS: ReadonlySet<string> = new Set(['visible', 'interactable']);

/** Whether a property decides *whether* the widget renders rather than *what* it
 *  shows. A variable read only by one of these is not on screen, so a missing
 *  value in it must not mark a widget that renders correctly. */
export function isVisibilityGateProperty(key: string): boolean {
  return UNIVERSAL_PROPERTY_KEYS.has(key);
}
