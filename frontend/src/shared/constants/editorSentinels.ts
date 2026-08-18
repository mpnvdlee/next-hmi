import type { ShellRegionId } from '@shared/types/config';

/**
 * Which top-level part of the editor tree a selection lives in. Callers that
 * already know this when selecting (e.g. a row rendered under a specific
 * section) can pass it to `setSelected` so consumers don't have to re-derive
 * it by walking the tree.
 */
export type EditorRegion = ShellRegionId | 'dialogs' | 'pages';

/**
 * Reserved `__name__`-style IDs the editor uses for non-component tree nodes
 * (top-level sections, settings/events panels, shell areas).
 *
 * These flow through `selectedId`, `setSelected`, drag identifiers, and the
 * tree's `Set<string>` open/collapsed state — so they're typed as a const
 * union to keep them in sync across files.
 */
export const EDITOR_NODE_IDS = {
  SETTINGS: '__settings__',
  EVENTS: '__events__',
  PAGES: '__pages__',
  DIALOGS: '__dialogs__',
  HEADER: '__header__',
  FOOTER: '__footer__',
  LEFT_SIDEBAR: '__leftSidebar__',
  RIGHT_SIDEBAR: '__rightSidebar__',
} as const;

export const SHELL_AREA_LABELS: Record<string, string> = {
  [EDITOR_NODE_IDS.HEADER]: 'Header',
  [EDITOR_NODE_IDS.FOOTER]: 'Footer',
  [EDITOR_NODE_IDS.LEFT_SIDEBAR]: 'Left Sidebar',
  [EDITOR_NODE_IDS.RIGHT_SIDEBAR]: 'Right Sidebar',
};

/**
 * Composite ids carried as selectedId / ctxMenu nodeId for tree rows that
 * aren't backed by a real entity: a page's section row and a page-group's
 * header/footer chrome row. The `::` separator is shared by both because
 * the two ids never collide (the caller already knows which `kind` to parse).
 */
const COMPOSITE_SEP = '::';
export const makePageSectionId = (pageId: string, sectionId: string): string =>
  `${pageId}${COMPOSITE_SEP}${sectionId}`;
export const parsePageSectionId = (id: string): [pageId: string, sectionId: string] => {
  const [pageId, sectionId] = id.split(COMPOSITE_SEP);
  return [pageId, sectionId];
};
export const makePageGroupAreaId = (groupId: string, area: 'header' | 'footer'): string =>
  `${groupId}${COMPOSITE_SEP}${area}`;
export const parsePageGroupAreaId = (id: string): [groupId: string, area: 'header' | 'footer'] => {
  const [groupId, area] = id.split(COMPOSITE_SEP);
  return [groupId, area as 'header' | 'footer'];
};
/** One slot of a reusable-component instance: the instance's widget id plus the
 *  slot name declared by its definition. */
export const makeWidgetSlotId = (widgetId: string, slot: string): string =>
  `${widgetId}${COMPOSITE_SEP}${slot}`;
export const parseWidgetSlotId = (id: string): [widgetId: string, slot: string] => {
  const [widgetId, slot] = id.split(COMPOSITE_SEP);
  return [widgetId, slot];
};

/**
 * Drop-zone ids used by dnd-kit. Each pair of mint/match must use the same
 * prefix; centralizing them here keeps the producer (tree row) and consumer
 * (the tree's drop resolver) from drifting.
 *
 * The whole tree shares one drag context, so every drop id names its owner —
 * a bare section or slot name would collide between two pages or two component
 * instances.
 */
const SECTION_ROW_DROP_PREFIX = '__section_row__:';
const SECTION_EMPTY_DROP_PREFIX = '__section_empty__:';
const PAGE_GROUP_SECTION_DROP_PREFIX = '__pgroup_section__:';

export const SECTION_DROP_PREFIXES = [SECTION_ROW_DROP_PREFIX, SECTION_EMPTY_DROP_PREFIX] as const;

export const sectionRowDropId = (pageId: string, sectionId: string): string =>
  `${SECTION_ROW_DROP_PREFIX}${pageId}${COMPOSITE_SEP}${sectionId}`;
export const sectionEmptyDropId = (pageId: string, sectionId: string): string =>
  `${SECTION_EMPTY_DROP_PREFIX}${pageId}${COMPOSITE_SEP}${sectionId}`;

/** `{ pageId, sectionId }` for a page-section drop id, null for anything else. */
export const parseSectionDropId = (id: string): { pageId: string; sectionId: string } | null => {
  const prefix = SECTION_DROP_PREFIXES.find((p) => id.startsWith(p));
  if (!prefix) return null;
  const [pageId, sectionId] = parsePageSectionId(id.slice(prefix.length));
  return sectionId ? { pageId, sectionId } : null;
};

export const pageGroupSectionDropId = (groupId: string, area: 'header' | 'footer'): string =>
  `${PAGE_GROUP_SECTION_DROP_PREFIX}${groupId}:${area}`;
export const pageGroupSectionEmptyDropId = (groupId: string, area: 'header' | 'footer'): string =>
  `${pageGroupSectionDropId(groupId, area)}:empty`;

/** `{ groupId, area }` for a page-group chrome drop id, null for anything else. */
export const parsePageGroupSectionDropId = (
  id: string,
): { groupId: string; area: 'header' | 'footer' } | null => {
  if (!id.startsWith(PAGE_GROUP_SECTION_DROP_PREFIX)) return null;
  const [groupId, area] = id.slice(PAGE_GROUP_SECTION_DROP_PREFIX.length).split(':');
  if (area !== 'header' && area !== 'footer') return null;
  return { groupId, area };
};

const WIDGET_SLOT_ROW_DROP_PREFIX = '__slot_row__:';
const WIDGET_SLOT_EMPTY_DROP_PREFIX = '__slot_empty__:';

export const WIDGET_SLOT_DROP_PREFIXES = [
  WIDGET_SLOT_ROW_DROP_PREFIX,
  WIDGET_SLOT_EMPTY_DROP_PREFIX,
] as const;

export const widgetSlotRowDropId = (widgetId: string, slot: string): string =>
  `${WIDGET_SLOT_ROW_DROP_PREFIX}${widgetId}${COMPOSITE_SEP}${slot}`;
export const widgetSlotEmptyDropId = (widgetId: string, slot: string): string =>
  `${WIDGET_SLOT_EMPTY_DROP_PREFIX}${widgetId}${COMPOSITE_SEP}${slot}`;

/** `{ widgetId, slot }` for a component-instance slot drop id, null otherwise. */
export const parseWidgetSlotDropId = (id: string): { widgetId: string; slot: string } | null => {
  const prefix = WIDGET_SLOT_DROP_PREFIXES.find((p) => id.startsWith(p));
  if (!prefix) return null;
  const [widgetId, slot] = parseWidgetSlotId(id.slice(prefix.length));
  return slot ? { widgetId, slot } : null;
};
