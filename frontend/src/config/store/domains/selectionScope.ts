import { SHELL_REGION_IDS, type PageNode, type WidgetConfig } from '@shared/types/config';
import type { AllAreas } from '@shared/store/configStoreHelpers';
import { getPageChildren } from '@shared/utils/pageContent';
import { isPageGroup } from '@shared/utils/pageTree';

/**
 * Narrowing for `selectedIds`, which the stores cannot do themselves — they hold ids
 * and have no access to the project tree.
 *
 * The store's contract is only that `selectedIds` holds whatever the UI put there.
 * Everything that acts on a selection — the properties panel, delete, duplicate,
 * copy/cut/paste, drag — comes through here first.
 */

export type SelectionScope =
  | { kind: 'empty' }
  | { kind: 'single'; id: string }
  /** Two or more ids, every one of them a widget. Comps are in document order. */
  | { kind: 'multi-widget'; ids: string[]; comps: WidgetConfig[] }
  /** Two or more ids where at least one is not a widget (a page, dialog, section…). */
  | { kind: 'multi-mixed'; ids: string[] };

interface WidgetIndex {
  /** Every widget id in editor-tree document order: shell regions, pages, dialogs. */
  order: string[];
  parentOf: Map<string, string | null>;
  compOf: Map<string, WidgetConfig>;
}

/** One walk of the whole project. Callers that render should memoize on the areas. */
function indexWidgets(p: AllAreas): WidgetIndex {
  const order: string[] = [];
  const parentOf = new Map<string, string | null>();
  const compOf = new Map<string, WidgetConfig>();

  const walk = (comps: WidgetConfig[] | undefined, parentId: string | null): void => {
    for (const comp of comps ?? []) {
      order.push(comp.id);
      parentOf.set(comp.id, parentId);
      compOf.set(comp.id, comp);
      walk(comp.children as WidgetConfig[] | undefined, comp.id);
    }
  };

  const walkPages = (nodes: PageNode[]): void => {
    for (const node of nodes) {
      if (isPageGroup(node)) {
        walk(node.header, null);
        walk(node.footer, null);
        walkPages(node.children);
      } else {
        walk(getPageChildren(node), null);
      }
    }
  };

  for (const region of SHELL_REGION_IDS) walk(p[region], null);
  walkPages(p.pages);
  for (const dialog of p.dialogs) walk(dialog.widgets, null);

  return { order, parentOf, compOf };
}

function ordered(index: WidgetIndex, ids: Iterable<string>): string[] {
  const wanted = new Set(ids);
  return index.order.filter((id) => wanted.has(id));
}

function hasSelectedAncestor(
  index: WidgetIndex,
  id: string,
  selected: ReadonlySet<string>,
): boolean {
  let parentId = index.parentOf.get(id) ?? null;
  while (parentId !== null) {
    if (selected.has(parentId)) return true;
    parentId = index.parentOf.get(parentId) ?? null;
  }
  return false;
}

export function classifySelection(ids: string[], p: AllAreas): SelectionScope {
  if (ids.length === 0) return { kind: 'empty' };
  if (ids.length === 1) return { kind: 'single', id: ids[0] };

  const index = indexWidgets(p);
  const unique = new Set(ids);
  const widgetIds = ordered(index, unique);
  if (widgetIds.length !== unique.size) return { kind: 'multi-mixed', ids };

  const comps: WidgetConfig[] = [];
  for (const id of widgetIds) {
    const comp = index.compOf.get(id);
    if (comp) comps.push(comp);
  }
  return { kind: 'multi-widget', ids: widgetIds, comps };
}

/** Widget ids in document order; anything that is not a widget is dropped. */
export function orderIdsByTree(ids: string[], p: AllAreas): string[] {
  return ordered(indexWidgets(p), ids);
}

/**
 * The selection with descendants of another selected node removed, in document
 * order. Every verb starts here: deleting a container already takes its children,
 * and duplicating both would clone the child twice.
 */
export function topLevelSelection(ids: string[], p: AllAreas): string[] {
  const index = indexWidgets(p);
  const selected = new Set(ids);
  return ordered(index, selected).filter((id) => !hasSelectedAncestor(index, id, selected));
}

/**
 * Whether a verb invoked on `nodeId` acts on the whole selection or on that node
 * alone. Both the tree and the preview re-point the selection on right-click, so a
 * node that is still part of it means the user can see what the verb will hit. The
 * components editor asks the same question of its own tree.
 */
export function verbActsOnSelection(selectedIds: string[], nodeId: string): boolean {
  return selectedIds.length > 1 && selectedIds.includes(nodeId);
}

/** The nodes a verb invoked on `nodeId` should act on, descendants of another
 *  selected node dropped. */
export function verbTargets(selectedIds: string[], nodeId: string, p: AllAreas): string[] {
  if (!verbActsOnSelection(selectedIds, nodeId)) return [nodeId];
  return topLevelSelection(selectedIds, p);
}

/**
 * Whether a Ctrl/Cmd-click on `candidateId` should extend the selection rather than
 * replace it. Only widgets group together — clicking a page, dialog or section row
 * always starts over.
 */
export function canExtendWith(ids: string[], candidateId: string, p: AllAreas): boolean {
  const index = indexWidgets(p);
  if (!index.compOf.has(candidateId)) return false;
  return ids.every((id) => index.compOf.has(id));
}
