/**
 * Where a drag inside one component definition lands — the flat-tree
 * counterpart of the page editor's `dropTarget.ts`, with the same bands: the
 * middle half of a container row drops inside it, the top and bottom quarters
 * drop beside the row.
 */

import type { ComponentDefinition } from '@shared/types/componentTypes';
import type { WidgetConfig } from '@shared/types/config';
import { isContainerHostType } from '@hmi/registry/widgetRegistry';
import { movedWidgetsOf } from '@shared/store/configStoreHelpers';
import { findComponentById } from '@shared/utils/widgetTree';
import type { DropBand } from '../editor/WidgetTree/dropTarget';
import { componentChildren, findWidgetParent } from './compositionTreeOps';

export interface CompositionDrop {
  nodeId: string;
  /** null = the definition root. */
  parentId: string | null;
  index: number;
}

/** The move removes the nodes first, so an index in a list they still sit in has
 *  to account for their own removal. */
function indexAfterRemoval(
  siblings: readonly WidgetConfig[],
  moved: ReadonlySet<string>,
  at: number,
): number {
  let above = 0;
  for (let i = 0; i < at && i < siblings.length; i++) {
    if (moved.has(siblings[i].id)) above += 1;
  }
  return at - above;
}

/**
 * Resolve a hovered row into a move, or null when the drop is not allowed.
 *
 * `movedIds` is every widget the drop will relocate, which is the whole selection
 * when the dragged row is part of it. Validation runs against all of them, not just
 * the dragged one: a drop inside any moved widget has its new parent swept out by
 * the same move, so the batch would silently land nowhere.
 */
export function resolveCompositionDrop(
  component: ComponentDefinition,
  activeId: string,
  overId: string,
  band: DropBand,
  movedIds: readonly string[] = [activeId],
): CompositionDrop | null {
  if (activeId === overId) return null;
  const dragged = findComponentById(componentChildren(component), activeId);
  if (!dragged) return null;
  // The definition's own id is the drop target of its empty placeholder.
  if (overId === component.id) {
    return { nodeId: activeId, parentId: null, index: componentChildren(component).length };
  }
  const over = findComponentById(componentChildren(component), overId);
  if (!over) return null;
  const moved = movedWidgetsOf(
    movedIds.map((id) => findComponentById(componentChildren(component), id)),
  );
  // A row under one of the moved widgets can host nothing: whichever parent the
  // drop resolves to leaves the tree with the widget that holds it.
  if (moved.descendants.has(overId)) return null;

  if (band === 'middle' && isContainerHostType(over.type)) {
    // A moved container cannot take the drop either, but its own place in its
    // parent still can — an edge band over it stays a valid "beside".
    if (moved.roots.has(overId)) return null;
    const children = (over.children as WidgetConfig[] | undefined) ?? [];
    return { nodeId: activeId, parentId: over.id, index: children.length };
  }

  const parent = findWidgetParent(component, overId);
  if (!parent) return null;
  const at = parent.index + (band === 'top' ? 0 : 1);
  return {
    nodeId: activeId,
    parentId: parent.parentId,
    index: indexAfterRemoval(parent.siblings, moved.roots, at),
  };
}
