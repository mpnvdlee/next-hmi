/**
 * The stdlib manifest's editor half, applied to the registry on import.
 *
 * Importing this module *is* the effect — there is nothing to call. It is
 * imported only from `src/config/`, which is what keeps the labels, options,
 * defaults, descriptions and icons out of every HMI route's static-import
 * closure while leaving them synchronously present for the editor: module
 * evaluation finishes before React renders, so the palette and the properties
 * panel see whole schemas on their first paint.
 *
 * Import it from a config module whenever a new editor surface starts reading
 * `widgetRegistry` outside `ConfigRoutes`' subtree.
 */
import editorManifest from '../../generated/stdlibManifest.editor.json';
import type { StdlibEditorEntry } from '@shared/types/widgetSchema';
import { applyStdlibEditorMetadata } from './widgetRegistry';

// Through `unknown` for the same reason the runtime half is: TypeScript infers
// the JSON as a union of per-widget object literals whose schemas differ, so it
// never structurally matches the entry type. stdlibManifest.test.ts is the
// guard that the generated file really has this shape.
applyStdlibEditorMetadata(editorManifest as unknown as Record<string, StdlibEditorEntry>);
