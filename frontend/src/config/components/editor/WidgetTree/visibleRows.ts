import { groupChildrenBySlot } from '@hmi/components/ComponentSlot/slotKey';
import { hasSlotSections, isContainerHostType, widgetSlots } from '@hmi/registry/widgetRegistry';
import {
  EDITOR_NODE_IDS,
  makePageGroupAreaId,
  makePageSectionId,
  makeWidgetSlotId,
} from '@shared/constants/editorSentinels';
import {
  SHELL_REGION_IDS,
  shellSectionIdForRegion,
  type DialogConfig,
  type PageConfig,
  type PageNode,
  type ShellRegionId,
  type WidgetConfig,
} from '@shared/types/config';
import { getPageChildren } from '@shared/utils/pageContent';
import { isPageGroup, pageHasExplicitSections, pageSectionGroups } from '@shared/utils/pageTree';

/**
 * The tree flattened to the rows a user can currently see, in render order.
 *
 * A Shift-range needs to know what sits between two rows, which only the render
 * knows — collapse state, search filtering and section folders all move rows in and
 * out. Deriving it here rather than reading the DOM keeps the range testable and
 * survives the popout panel.
 *
 * This must stay in step with WidgetTree's render. `visibleRows.test.ts` renders the
 * real tree and compares row-for-row, so drift fails loudly rather than silently
 * producing the wrong range.
 */

export type VisibleRowKind =
  | 'settings'
  | 'events'
  | 'shell-section'
  | 'pages-section'
  | 'dialogs-section'
  | 'page'
  | 'page-group'
  | 'page-group-area'
  | 'page-section'
  | 'dialog'
  | 'widget'
  | 'widget-slot';

export interface VisibleRow {
  /** The id this row's own selection would use. */
  id: string;
  kind: VisibleRowKind;
  /** Only widget rows join a selection of more than one. */
  selectable: boolean;
  depth: number;
}

export interface VisibleWidgetRow {
  id: string;
  depth: number;
  /** Slot folders are structure, not widgets — a Shift-range steps over them. */
  selectable: boolean;
}

/**
 * The rows a widget subtree contributes, in render order — the walk both editors'
 * trees render from.
 *
 * Only a container host shows its children, a collapsed row shows none, and an
 * instance addressing several slots regroups them under one independently
 * collapsible folder per slot. The two trees differ only in what they hang this
 * walk off (shell regions, pages and dialogs here; a flat definition in the
 * components editor), so the widget part lives here once.
 */
export function walkVisibleWidgets(
  widgets: readonly WidgetConfig[],
  depth: number,
  collapsed: ReadonlySet<string>,
  emit: (row: VisibleWidgetRow) => void,
): void {
  for (const widget of widgets) {
    emit({ id: widget.id, depth, selectable: true });
    if (!isContainerHostType(widget.type) || collapsed.has(widget.id)) continue;
    const children = (widget.children ?? []) as WidgetConfig[];
    const slots = widgetSlots(widget.type);
    if (!hasSlotSections(widget.type)) {
      walkVisibleWidgets(children, depth + 1, collapsed, emit);
      continue;
    }
    const groups = groupChildrenBySlot(children, slots);
    for (const slot of slots) {
      const slotId = makeWidgetSlotId(widget.id, slot);
      emit({ id: slotId, depth: depth + 1, selectable: false });
      if (collapsed.has(slotId)) continue;
      walkVisibleWidgets(groups[slot], depth + 2, collapsed, emit);
    }
  }
}

export interface VisibleRowsInput {
  /** Post-search page nodes — pass `filteredPages`. */
  pages: PageNode[];
  /** Post-search shell widgets — pass `filteredShell`. */
  shell: Record<ShellRegionId, WidgetConfig[]>;
  /** Post-search dialogs — pass `filteredDialogs`. */
  dialogs: DialogConfig[];
  /** Pass `effectiveCollapsed`, not the raw collapse set. */
  collapsed: ReadonlySet<string>;
  /** Pass `effectiveSectionsOpen`. */
  sectionsOpen: ReadonlySet<string>;
  visible: {
    settings: boolean;
    events: boolean;
    pages: boolean;
    dialogs: boolean;
    /** Shell regions the search has filtered away entirely. */
    hiddenShellRegions: ReadonlySet<ShellRegionId>;
  };
}

export function flattenVisibleRows(input: VisibleRowsInput): VisibleRow[] {
  const { pages, shell, dialogs, collapsed, sectionsOpen, visible } = input;
  const rows: VisibleRow[] = [];

  const push = (id: string, kind: VisibleRowKind, depth: number): void => {
    rows.push({ id, kind, selectable: kind === 'widget', depth });
  };

  const pushWidgets = (comps: readonly WidgetConfig[], depth: number): void => {
    walkVisibleWidgets(comps, depth, collapsed, (row) =>
      push(row.id, row.selectable ? 'widget' : 'widget-slot', row.depth),
    );
  };

  const pushPage = (page: PageConfig, depth: number): void => {
    push(page.id, 'page', depth);
    if (collapsed.has(page.id)) return;
    if (pageHasExplicitSections(page)) {
      for (const { id: sectionId } of pageSectionGroups(page)) {
        const sectionKey = makePageSectionId(page.id, sectionId);
        push(sectionKey, 'page-section', depth + 1);
        if (collapsed.has(sectionKey)) continue;
        pushWidgets(page.sections[sectionId] ?? [], depth + 2);
      }
      return;
    }
    pushWidgets(getPageChildren(page), depth + 1);
  };

  const pushGroupArea = (
    groupId: string,
    area: 'header' | 'footer',
    widgets: WidgetConfig[],
    depth: number,
  ): void => {
    const areaId = makePageGroupAreaId(groupId, area);
    push(areaId, 'page-group-area', depth);
    if (collapsed.has(areaId)) return;
    pushWidgets(widgets, depth + 1);
  };

  const pushPageNode = (node: PageNode, depth: number): void => {
    if (!isPageGroup(node)) {
      pushPage(node, depth);
      return;
    }
    push(node.id, 'page-group', depth);
    if (collapsed.has(node.id)) return;
    pushGroupArea(node.id, 'header', node.header ?? [], depth + 1);
    for (const child of node.children) pushPageNode(child, depth + 1);
    pushGroupArea(node.id, 'footer', node.footer ?? [], depth + 1);
  };

  if (visible.settings) push(EDITOR_NODE_IDS.SETTINGS, 'settings', 0);
  if (visible.events) push(EDITOR_NODE_IDS.EVENTS, 'events', 0);

  for (const region of SHELL_REGION_IDS) {
    if (visible.hiddenShellRegions.has(region)) continue;
    const sectionId = shellSectionIdForRegion(region);
    push(sectionId, 'shell-section', 0);
    if (!sectionsOpen.has(sectionId)) continue;
    pushWidgets(shell[region], 1);
  }

  if (visible.pages) {
    push(EDITOR_NODE_IDS.PAGES, 'pages-section', 0);
    if (sectionsOpen.has(EDITOR_NODE_IDS.PAGES)) {
      for (const node of pages) pushPageNode(node, 1);
    }
  }

  if (visible.dialogs) {
    push(EDITOR_NODE_IDS.DIALOGS, 'dialogs-section', 0);
    if (sectionsOpen.has(EDITOR_NODE_IDS.DIALOGS)) {
      for (const dialog of dialogs) {
        push(dialog.id, 'dialog', 1);
        if (collapsed.has(dialog.id)) continue;
        pushWidgets(dialog.widgets, 2);
      }
    }
  }

  return rows;
}

/**
 * The inclusive run of rows between two ids, in either click order. Empty when
 * either id is no longer visible — the caller falls back to a plain selection.
 */
export function rowsBetween(rows: VisibleRow[], fromId: string, toId: string): VisibleRow[] {
  const from = rows.findIndex((row) => row.id === fromId);
  const to = rows.findIndex((row) => row.id === toId);
  if (from === -1 || to === -1) return [];
  return from <= to ? rows.slice(from, to + 1) : rows.slice(to, from + 1);
}
