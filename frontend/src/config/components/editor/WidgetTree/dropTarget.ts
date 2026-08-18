/**
 * Where a tree drag lands.
 *
 * The whole tree is one drag context, so a drop is not "reorder this list" any
 * more: the row under the pointer plus the band of that row decide both the new
 * parent and the position. Top and bottom quarters mean "beside this row";
 * the middle half means "inside it", offered only by rows that can hold
 * children. Section, slot and empty-placeholder rows are always "inside".
 */

import type { WidgetParentTarget } from '@shared/store/configStore';
import {
  SHELL_REGION_IDS,
  regionForShellSectionId,
  type PageNode,
  type ShellRegionId,
  type WidgetConfig,
} from '@shared/types/config';
import {
  parsePageGroupSectionDropId,
  parseSectionDropId,
  parseWidgetSlotDropId,
} from '@shared/constants/editorSentinels';
import { findPageNodeById, isPageGroup, pageHasExplicitSections } from '@shared/utils/pageTree';
import { getPageChildren } from '@shared/utils/pageContent';
import { hasSlotSections, isContainerHostType } from '@hmi/registry/widgetRegistry';
import {
  collectMovedWidgets,
  type AllAreas,
  type MovedWidgets,
} from '@shared/store/configStoreHelpers';
import { findParentInfo, type WidgetParentInfo } from './treeUtils';
import { findWidgetEverywhere } from './clipboardDispatch';

export type DropBand = 'top' | 'middle' | 'bottom';

/** `beside` marks a plan that lands next to the hovered row rather than inside
 *  it — an index alone does not say which, since a row that hosts the drop can
 *  also name a position within itself. */
export type DropPlan =
  | {
      kind: 'widget';
      nodeId: string;
      target: WidgetParentTarget;
      index?: number;
      beside?: true;
    }
  | { kind: 'page'; nodeId: string; groupId: string | null; index?: number; beside?: true };

/** Pointer y at drop time. dnd-kit reports the press position and the delta, not
 *  the live pointer; keyboard drags have no pointer at all. */
export function pointerYOf(activatorEvent: Event | null, deltaY: number): number | null {
  const y = (activatorEvent as PointerEvent | null)?.clientY;
  return typeof y === 'number' ? y + deltaY : null;
}

export function bandOf(rect: { top: number; height: number }, pointerY: number | null): DropBand {
  if (pointerY === null) return 'middle';
  const offset = (pointerY - rect.top) / (rect.height || 1);
  if (offset < 0.25) return 'top';
  if (offset > 0.75) return 'bottom';
  return 'middle';
}

function parentTargetOf(parent: WidgetParentInfo): WidgetParentTarget {
  switch (parent.kind) {
    case 'container':
      return {
        kind: 'container',
        containerId: parent.parentId,
        slot: parent.siblings[parent.index]?.slot,
      };
    case 'shell-area':
      return { kind: 'shell-area', region: parent.region };
    case 'dialog':
      return { kind: 'dialog', dialogId: parent.dialogId };
    case 'page-section':
      return { kind: 'page-section', pageId: parent.pageId, sectionId: parent.sectionId };
    case 'page-group-chrome':
      return { kind: 'page-group-chrome', groupId: parent.groupId, area: parent.area };
  }
}

/** The move removes the nodes before inserting them, so an index taken from a
 *  list they are still in has to account for their own removal. */
function indexAfterRemoval(
  siblings: { id: string }[],
  moved: ReadonlySet<string>,
  at: number,
): number {
  let above = 0;
  for (let i = 0; i < at && i < siblings.length; i++) {
    if (moved.has(siblings[i].id)) above += 1;
  }
  return at - above;
}

function isMovedWidgets(moved: readonly string[] | MovedWidgets): moved is MovedWidgets {
  return !Array.isArray(moved);
}

function isSelfOrDescendantPage(node: PageNode, candidateId: string): boolean {
  if (node.id === candidateId) return true;
  if (!isPageGroup(node)) return false;
  return node.children.some((child) => isSelfOrDescendantPage(child, candidateId));
}

/** Container a widget row would host the drop in, honouring slot sections. */
function containerTarget(widget: WidgetConfig): WidgetParentTarget | null {
  if (!isContainerHostType(widget.type)) return null;
  // A multi-slot instance needs an explicit slot, so its own row cannot take a
  // drop — the slot rows underneath it do.
  if (hasSlotSections(widget.type)) return null;
  return { kind: 'container', containerId: widget.id };
}

function pageChildTarget(p: AllAreas, pageId: string): WidgetParentTarget | null {
  const page = findPageNodeById(p.pages, pageId);
  if (!page || isPageGroup(page)) return null;
  // With Header/Content/Footer folders the section rows take the drop instead.
  if (pageHasExplicitSections(page)) return null;
  const sectionId = Object.keys(page.sections)[0] ?? 'content';
  return { kind: 'page-section', pageId, sectionId };
}

function widgetBeside(
  p: AllAreas,
  activeId: string,
  moved: ReadonlySet<string>,
  overWidgetId: string,
  after: boolean,
): DropPlan | null {
  const parent = findParentInfo(p, overWidgetId);
  if (!parent) return null;
  const at = parent.index + (after ? 1 : 0);
  return {
    kind: 'widget',
    nodeId: activeId,
    target: parentTargetOf(parent),
    index: indexAfterRemoval(parent.siblings, moved, at),
    beside: true,
  };
}

function pageSiblings(p: AllAreas, pageId: string): { list: PageNode[]; groupId: string | null } {
  const walk = (
    nodes: PageNode[],
    groupId: string | null,
  ): { list: PageNode[]; groupId: string | null } | null => {
    if (nodes.some((n) => n.id === pageId)) return { list: nodes, groupId };
    for (const node of nodes) {
      if (!isPageGroup(node)) continue;
      const found = walk(node.children, node.id);
      if (found) return found;
    }
    return null;
  };
  return walk(p.pages, null) ?? { list: p.pages, groupId: null };
}

function pageBeside(p: AllAreas, activeId: string, overPageId: string, after: boolean): DropPlan {
  const { list, groupId } = pageSiblings(p, overPageId);
  const at = list.findIndex((n) => n.id === overPageId) + (after ? 1 : 0);
  return {
    kind: 'page',
    nodeId: activeId,
    groupId,
    index: indexAfterRemoval(list, new Set([activeId]), at),
    beside: true,
  };
}

/**
 * Resolve a hovered row into a move, or null when the drop is not allowed —
 * a node into its own subtree, a page into a widget, a widget into the page
 * list, or a row that cannot host what is being dragged.
 *
 * `movedIds` is every widget the drop will relocate, which is the whole selection
 * when the dragged row is part of it. Validation runs against all of them, not
 * just the dragged one: a drop inside any moved widget has its new parent swept
 * out by the same move, and the batch would be lost instead of landing. A caller
 * that resolves the same drop on every pointer move can pass a `MovedWidgets`
 * from `collectMovedWidgets` instead of the ids, since the set it builds depends
 * only on the project and the ids and neither changes during a drag.
 */
export function resolveDropTarget(
  p: AllAreas,
  activeId: string,
  overId: string,
  band: DropBand,
  movedIds: readonly string[] | MovedWidgets = [activeId],
): DropPlan | null {
  if (activeId === overId) return null;

  const draggedWidget = findWidgetEverywhere(p, activeId);
  const draggedPage = draggedWidget ? null : findPageNodeById(p.pages, activeId);
  if (!draggedWidget && !draggedPage) return null;
  const moved = isMovedWidgets(movedIds) ? movedIds : collectMovedWidgets(p, movedIds);

  // Section, slot and page-group chrome rows are always "drop inside".
  const slot = parseWidgetSlotDropId(overId);
  if (slot) {
    if (!draggedWidget) return null;
    if (moved.roots.has(slot.widgetId) || moved.descendants.has(slot.widgetId)) return null;
    return {
      kind: 'widget',
      nodeId: activeId,
      target: { kind: 'container', containerId: slot.widgetId, slot: slot.slot },
    };
  }
  const section = parseSectionDropId(overId);
  if (section) {
    if (!draggedWidget) return null;
    return {
      kind: 'widget',
      nodeId: activeId,
      target: { kind: 'page-section', pageId: section.pageId, sectionId: section.sectionId },
    };
  }
  const chrome = parsePageGroupSectionDropId(overId);
  if (chrome) {
    if (!draggedWidget) return null;
    return {
      kind: 'widget',
      nodeId: activeId,
      target: { kind: 'page-group-chrome', groupId: chrome.groupId, area: chrome.area },
    };
  }

  // The empty placeholder carries the region id, the section row its own id.
  const region = (SHELL_REGION_IDS as readonly string[]).includes(overId)
    ? (overId as ShellRegionId)
    : regionForShellSectionId(overId);
  if (region) {
    if (!draggedWidget) return null;
    return { kind: 'widget', nodeId: activeId, target: { kind: 'shell-area', region } };
  }

  const overWidget = findWidgetEverywhere(p, overId);
  if (overWidget) {
    if (!draggedWidget) return null;
    // A row under one of the moved widgets can host nothing: whichever parent the
    // drop resolves to leaves the tree with the widget that holds it.
    if (moved.descendants.has(overId)) return null;
    if (band === 'middle') {
      const target = containerTarget(overWidget);
      // A moved container cannot take the drop either, but its own place in its
      // parent still can — an edge band over it stays a valid "beside".
      if (target)
        return moved.roots.has(overId) ? null : { kind: 'widget', nodeId: activeId, target };
    }
    return widgetBeside(p, activeId, moved.roots, overId, band !== 'top');
  }

  const overPage = findPageNodeById(p.pages, overId);
  if (overPage) {
    if (draggedPage) {
      if (isSelfOrDescendantPage(draggedPage, overId)) return null;
      if (band === 'middle' && isPageGroup(overPage)) {
        return { kind: 'page', nodeId: activeId, groupId: overPage.id };
      }
      return pageBeside(p, activeId, overId, band !== 'top');
    }
    // A widget dropped on a page row lands in that page's content.
    if (isPageGroup(overPage)) return null;
    const target = pageChildTarget(p, overId);
    if (!target) return null;
    return {
      kind: 'widget',
      nodeId: activeId,
      target,
      index: indexAfterRemoval(
        getPageChildren(overPage),
        moved.roots,
        getPageChildren(overPage).length,
      ),
    };
  }

  const dialog = p.dialogs.find((d) => d.id === overId);
  if (dialog) {
    if (!draggedWidget) return null;
    return { kind: 'widget', nodeId: activeId, target: { kind: 'dialog', dialogId: dialog.id } };
  }

  return null;
}

/** How the hovered row should render the pending drop. */
export function dropFeedback(
  plan: DropPlan | null,
  band: DropBand,
): { edge?: 'top' | 'bottom'; into: boolean } {
  if (!plan) return { into: false };
  if (!plan.beside) return { into: true };
  return { edge: band === 'top' ? 'top' : 'bottom', into: false };
}
