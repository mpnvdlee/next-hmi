/**
 * Widget-tree operations for a single component definition.
 *
 * The page editor keeps these in configStore (duplicate, move, paste); a
 * definition is a flat `children` array owned by the components editor, so the
 * same operations live here as pure functions over a ComponentDefinition. The
 * clipboard format is shared with the page editor — a widget copied in either
 * editor pastes in the other.
 */

import type { ComponentDefinition } from '@shared/types/componentTypes';
import type { WidgetConfig } from '@shared/types/config';
import { isRecord } from '@shared/types/propertyValueGuards';
import { collectWidgetIds, deepCloneComponent } from '@shared/store/configStoreHelpers';
import { verbActsOnSelection } from '@config/store/domains/selectionScope';
import { mapAllComponents, removeComponentById } from '../editor/WidgetTree/treeUtils';
import { batchInsertOrder } from '../editor/WidgetTree/insertComponent';
import { pasteToast, readMultiEnvelope } from '../editor/WidgetTree/clipboardOps';
import { walkVisibleWidgets, type VisibleWidgetRow } from '../editor/WidgetTree/visibleRows';

export interface WidgetParent {
  /** null when the widget sits at the definition root. */
  parentId: string | null;
  siblings: WidgetConfig[];
  index: number;
}

export function componentChildren(component: ComponentDefinition): WidgetConfig[] {
  return component.children as WidgetConfig[];
}

export function takenWidgetIds(component: ComponentDefinition): Set<string> {
  const taken = new Set<string>();
  collectWidgetIds(componentChildren(component), taken);
  return taken;
}

function withChildren(
  component: ComponentDefinition,
  children: WidgetConfig[],
): ComponentDefinition {
  return { ...component, children };
}

export function findWidgetParent(component: ComponentDefinition, id: string): WidgetParent | null {
  function walk(siblings: WidgetConfig[], parentId: string | null): WidgetParent | null {
    const index = siblings.findIndex((c) => c.id === id);
    if (index !== -1) return { parentId, siblings, index };
    for (const child of siblings) {
      if (!child.children) continue;
      const found = walk(child.children as WidgetConfig[], child.id);
      if (found) return found;
    }
    return null;
  }
  return walk(componentChildren(component), null);
}

function replaceSiblings(
  component: ComponentDefinition,
  parentId: string | null,
  siblings: WidgetConfig[],
): ComponentDefinition {
  if (!parentId) return withChildren(component, siblings);
  return withChildren(
    component,
    mapAllComponents(componentChildren(component), (c) =>
      c.id === parentId ? { ...c, children: siblings } : c,
    ),
  );
}

/** Append into a container, or into the definition root when `parentId` is the
 *  component's own id (how the tree and preview name the root target). */
export function appendWidget(
  component: ComponentDefinition,
  parentId: string | null,
  widget: WidgetConfig,
): ComponentDefinition {
  const resolved = !parentId || parentId === component.id ? null : parentId;
  if (!resolved) return withChildren(component, [...componentChildren(component), widget]);
  return withChildren(
    component,
    mapAllComponents(componentChildren(component), (c) =>
      c.id === resolved
        ? { ...c, children: [...((c.children as WidgetConfig[]) ?? []), widget] }
        : c,
    ),
  );
}

function insertAfter(
  component: ComponentDefinition,
  siblingId: string,
  widget: WidgetConfig,
): ComponentDefinition | null {
  const parent = findWidgetParent(component, siblingId);
  if (!parent) return null;
  const at = parent.index + 1;
  const siblings = [...parent.siblings.slice(0, at), widget, ...parent.siblings.slice(at)];
  return replaceSiblings(component, parent.parentId, siblings);
}

/** Where a paste or an add lands: inside a container (or the root), or next to a leaf. */
export function insertWidgetAt(
  component: ComponentDefinition,
  targetId: string,
  kind: 'container' | 'leaf' | 'root',
  widget: WidgetConfig,
): ComponentDefinition | null {
  if (kind === 'leaf') return insertAfter(component, targetId, widget);
  return appendWidget(component, kind === 'root' ? null : targetId, widget);
}

/** Insert at a known position in a parent's list — what a drag resolves to,
 *  as opposed to the append/sibling-after a menu paste uses. */
export function insertWidgetAtIndex(
  component: ComponentDefinition,
  parentId: string | null,
  widget: WidgetConfig,
  index: number,
): ComponentDefinition {
  const resolved = !parentId || parentId === component.id ? null : parentId;
  const splice = (list: WidgetConfig[]) => {
    const next = [...list];
    next.splice(index, 0, widget);
    return next;
  };
  if (!resolved) return withChildren(component, splice(componentChildren(component)));
  return withChildren(
    component,
    mapAllComponents(componentChildren(component), (c) =>
      c.id === resolved ? { ...c, children: splice((c.children as WidgetConfig[]) ?? []) } : c,
    ),
  );
}

/** Drag-and-drop's move: same id, explicit parent and position. */
export function moveWidgetToIndex(
  component: ComponentDefinition,
  id: string,
  parentId: string | null,
  index: number,
): ComponentDefinition | null {
  const parent = findWidgetParent(component, id);
  if (!parent) return null;
  const widget = parent.siblings[parent.index];
  if (parentId && isInSubtree(widget, parentId)) return null;
  const without = withChildren(component, removeComponentById(componentChildren(component), id));
  return insertWidgetAtIndex(without, parentId, widget, index);
}

/** True when `candidateId` is the widget itself or anything beneath it. */
export function isInSubtree(widget: WidgetConfig, candidateId: string): boolean {
  if (widget.id === candidateId) return true;
  const ids = new Set<string>();
  collectWidgetIds(widget.children as WidgetConfig[] | undefined, ids);
  return ids.has(candidateId);
}

// ── Multi-selection ──────────────────────────────────────────────────────────
//
// The page editor's equivalents live in configStore and selectionScope; a
// definition is one flat tree, so these stay pure functions over it.

export type { VisibleWidgetRow };

/**
 * Widget rows the tree currently shows, in render order — what a Shift-range slices.
 *
 * The compositions tree renders the page editor's `TreeNode`, so the walk itself is
 * shared with `visibleRows.ts`; a definition is one flat list, so this is only its
 * root entry point. `compositionVisibleRows.test.tsx` renders the real tree and
 * compares row-for-row, so drift fails loudly rather than silently slicing rows the
 * user cannot see — the same guard the page editor has.
 */
export function flattenVisibleWidgets(
  component: ComponentDefinition,
  collapsedIds: ReadonlySet<string>,
): VisibleWidgetRow[] {
  const rows: VisibleWidgetRow[] = [];
  walkVisibleWidgets(componentChildren(component), 0, collapsedIds, (row) => rows.push(row));
  return rows;
}

/** The selection with descendants of another selected widget dropped, in tree order. */
export function topLevelWidgetIds(component: ComponentDefinition, ids: string[]): string[] {
  const selected = new Set(ids);
  const kept: string[] = [];
  const walk = (widgets: WidgetConfig[], underSelection: boolean): void => {
    for (const widget of widgets) {
      const isSelected = selected.has(widget.id);
      if (isSelected && !underSelection) kept.push(widget.id);
      walk((widget.children as WidgetConfig[]) ?? [], underSelection || isSelected);
    }
  };
  walk(componentChildren(component), false);
  return kept;
}

/** The widgets an action invoked on `nodeId` acts on: the whole selection when
 *  that row is part of it, the row alone otherwise. A drag and a menu verb ask the
 *  same question, and the drop indicator has to ask it before the drop does. */
export function widgetSelectionTargets(
  component: ComponentDefinition,
  selectedIds: readonly string[],
  nodeId: string,
): string[] {
  const ids = [...selectedIds];
  return verbActsOnSelection(ids, nodeId) ? topLevelWidgetIds(component, ids) : [nodeId];
}

export function removeWidgets(component: ComponentDefinition, ids: string[]): ComponentDefinition {
  return ids.reduce(
    (acc, id) => withChildren(acc, removeComponentById(componentChildren(acc), id)),
    component,
  );
}

/** Each clone lands directly after its own original. One shared id pool, so two
 *  clones in a batch can never collide. */
export function duplicateWidgets(
  component: ComponentDefinition,
  ids: string[],
): { component: ComponentDefinition; newIds: string[] } | null {
  const taken = takenWidgetIds(component);
  let updated = component;
  const newIds: string[] = [];
  for (const id of ids) {
    const parent = findWidgetParent(updated, id);
    if (!parent) continue;
    const clone = deepCloneComponent(parent.siblings[parent.index], taken);
    const next = insertAfter(updated, id, clone);
    if (!next) continue;
    updated = next;
    newIds.push(clone.id);
  }
  return newIds.length > 0 ? { component: updated, newIds } : null;
}

export function insertWidgetsAt(
  component: ComponentDefinition,
  targetId: string,
  kind: 'container' | 'leaf' | 'root',
  widgets: WidgetConfig[],
): ComponentDefinition | null {
  let updated = component;
  for (const widget of batchInsertOrder(widgets, kind)) {
    const next = insertWidgetAt(updated, targetId, kind, widget);
    if (!next) return null;
    updated = next;
  }
  return updated;
}

export function moveWidgetsWithin(
  component: ComponentDefinition,
  ids: string[],
  targetId: string,
  kind: 'container' | 'leaf' | 'root',
): ComponentDefinition | null {
  const moving: WidgetConfig[] = [];
  for (const id of ids) {
    const parent = findWidgetParent(component, id);
    if (!parent) return null;
    const widget = parent.siblings[parent.index];
    // Refused before anything is removed, so a rejected drop leaves the tree whole.
    if (isInSubtree(widget, targetId)) return null;
    moving.push(widget);
  }
  return insertWidgetsAt(removeWidgets(component, ids), targetId, kind, moving);
}

/** Drag-and-drop's move for several widgets: they land contiguously, in order.
 *  `index` is the position in the target list once the moved widgets are out of
 *  it — what `resolveCompositionDrop` returns. */
export function moveWidgetsToIndex(
  component: ComponentDefinition,
  ids: string[],
  parentId: string | null,
  index: number,
): ComponentDefinition | null {
  const moving: WidgetConfig[] = [];
  for (const id of ids) {
    const parent = findWidgetParent(component, id);
    if (!parent) return null;
    const widget = parent.siblings[parent.index];
    if (parentId && isInSubtree(widget, parentId)) return null;
    moving.push(widget);
  }
  let updated = removeWidgets(component, ids);

  moving.forEach((widget, i) => {
    updated = insertWidgetAtIndex(updated, parentId, widget, index + i);
  });
  return updated;
}

// ── Clipboard ────────────────────────────────────────────────────────────────

function isWidgetConfig(value: unknown): value is WidgetConfig {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== 'string' ||
    typeof value.type !== 'string' ||
    typeof value.name !== 'string'
  )
    return false;
  return (
    !('children' in value) ||
    (Array.isArray(value.children) && value.children.every(isWidgetConfig))
  );
}

export function isComponentDefinition(value: unknown): value is ComponentDefinition {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    isRecord(value.componentProperties) &&
    Array.isArray(value.children) &&
    value.children.every(isWidgetConfig)
  );
}

export type CompositionClipboard =
  | { kind: 'definition'; node: ComponentDefinition }
  | { kind: 'widget'; node: WidgetConfig }
  | { kind: 'widgets'; nodes: WidgetConfig[] };

function isPlainWidgetPayload(value: unknown): value is WidgetConfig {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    typeof value.name === 'string' &&
    !('sections' in value) &&
    !('widgets' in value)
  );
}

export function classifyCompositionClipboard(parsed: unknown): CompositionClipboard | null {
  if (isComponentDefinition(parsed) && parsed.name.trim())
    return { kind: 'definition', node: parsed };
  // The page editor's multi-copy envelope, read by the writer's own reader — a
  // definition can hold the widgets it carries, so the two editors stay
  // interchangeable for batches too.
  const multi = readMultiEnvelope(parsed);
  if (multi) {
    const nodes: WidgetConfig[] = [];
    // A definition holds widgets and nothing else; the envelope's other node
    // kinds (pages, groups, dialogs) have nowhere to land here.
    for (const entry of multi) {
      if (entry.kind !== 'widget') return null;
      nodes.push(entry.node);
    }
    return { kind: 'widgets', nodes };
  }
  if (isPlainWidgetPayload(parsed)) {
    return { kind: 'widget', node: parsed };
  }
  return null;
}

/** Reads the system clipboard once and tells a whole component definition apart
 *  from a single widget, so one Paste item can serve both. */
export async function readCompositionClipboard(): Promise<CompositionClipboard | null> {
  let text: string;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    pasteToast('error', 'Clipboard read blocked');
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    pasteToast('error', 'Clipboard is not valid JSON');
    return null;
  }
  const entry = classifyCompositionClipboard(parsed);
  if (!entry) {
    pasteToast('error', 'Clipboard is not a component or widget');
    return null;
  }
  return entry;
}
