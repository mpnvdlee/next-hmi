/**
 * The built-in-widgets manifest's editor half, applied to the registry on import
 * — importing this module *is* the effect, there is nothing to call.
 *
 * Imported only from `src/config/`, which keeps labels, options, defaults,
 * descriptions and icons out of every HMI route's static-import closure while
 * leaving them synchronously present for the editor. Import it from a config
 * module whenever a new editor surface reads `widgetRegistry` outside
 * `ConfigRoutes`' subtree.
 */
import editorManifest from '../../generated/builtinWidgetsManifest.editor.json';
import type { BuiltinWidgetEditorEntry } from '@shared/types/widgetSchema';
import { applyBuiltinWidgetsEditorMetadata } from './widgetRegistry';

// Through `unknown` for the same reason the runtime half is: tsc infers the JSON
// as a union of per-widget literals whose schemas differ, so it never matches
// the entry type. builtinWidgetsManifest.test.ts guards the real shape.
applyBuiltinWidgetsEditorMetadata(
  editorManifest as unknown as Record<string, BuiltinWidgetEditorEntry>,
);
