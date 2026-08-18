import type {
  WidgetConfig,
  DialogConfig,
  PageConfig,
  PageGroupChild,
  PageGroupConfig,
  PageNode,
} from '../types/config';
import {
  getPageChildren,
  mapPageSections,
  replacePageSectionWidgets,
} from '@shared/utils/pageContent';
import { isPageGroup, mapPageGroupChrome, mapPages } from '@shared/utils/pageTree';
import { takeSlugId } from '@shared/utils/id';

/** Collect every widget id in a (possibly nested) widget list into `acc`. */
export function collectWidgetIds(widgets: WidgetConfig[] | undefined, acc: Set<string>): void {
  for (const w of widgets ?? []) {
    if (w?.id) acc.add(w.id);
    collectWidgetIds(w.children as WidgetConfig[] | undefined, acc);
  }
}

/** Remove a node by ID from anywhere in the component tree. */
export function removeNode(
  components: WidgetConfig[],
  id: string,
): { arr: WidgetConfig[]; removed: WidgetConfig | null } {
  const topRemoved = components.find((c) => c.id === id) ?? null;
  if (topRemoved) {
    return { arr: components.filter((c) => c.id !== id), removed: topRemoved };
  }
  let removed: WidgetConfig | null = null;
  const arr = components.map((c) => {
    if (!c.children || removed) return c;
    const res = removeNode(c.children, id);
    if (res.removed) removed = res.removed;
    return res.removed ? { ...c, children: res.arr } : c;
  });
  return { arr, removed };
}

/**
 * Drop every widget whose id is in `ids`, at any depth, recording the node that came
 * out under its id. A widget that sits inside another one being removed leaves with
 * it and is not recorded separately.
 *
 * Returns the array it was given when nothing matched, so a batch write can leave the
 * areas it never reached with the object identities React already holds.
 */
export function pruneWidgets(
  widgets: WidgetConfig[],
  ids: ReadonlySet<string>,
  removed: Map<string, WidgetConfig>,
): WidgetConfig[] {
  if (removed.size === ids.size) return widgets;
  let changed = false;
  const next: WidgetConfig[] = [];
  for (const widget of widgets) {
    if (ids.has(widget.id)) {
      removed.set(widget.id, widget);
      changed = true;
      continue;
    }
    const children = widget.children as WidgetConfig[] | undefined;
    const nextChildren = children ? pruneWidgets(children, ids, removed) : children;
    if (nextChildren === children) {
      next.push(widget);
      continue;
    }
    changed = true;
    next.push({ ...widget, children: nextChildren });
  }
  return changed ? next : widgets;
}

/**
 * Clone every widget whose id is in `ids` directly after its original, recording the
 * new id under the original's. `taken` is shared across the batch so two clones can
 * never be handed the same id.
 *
 * Children are visited first, so a clone of a container carries whatever clones its
 * own descendants produced. Same identity contract as `pruneWidgets`.
 */
export function duplicateWidgets(
  widgets: WidgetConfig[],
  ids: ReadonlySet<string>,
  taken: Set<string>,
  created: Map<string, string>,
): WidgetConfig[] {
  if (created.size === ids.size) return widgets;
  let changed = false;
  const next: WidgetConfig[] = [];
  for (const widget of widgets) {
    const children = widget.children as WidgetConfig[] | undefined;
    const nextChildren = children ? duplicateWidgets(children, ids, taken, created) : children;
    const updated = nextChildren === children ? widget : { ...widget, children: nextChildren };
    if (updated !== widget) changed = true;
    next.push(updated);
    if (!ids.has(widget.id) || created.has(widget.id)) continue;
    const clone = deepCloneComponent(updated, taken);
    created.set(widget.id, clone.id);
    next.push(clone);
    changed = true;
  }
  return changed ? next : widgets;
}

/** Deep-clone a component subtree, assigning fresh unique slug IDs to every node.
 *  `taken` accumulates assigned IDs so siblings/descendants stay unique. */
export function deepCloneComponent(comp: WidgetConfig, taken: Set<string>): WidgetConfig {
  const id = takeSlugId(comp.name || comp.type || 'widget', taken);
  return {
    ...comp,
    id,
    children: comp.children?.map((c) => deepCloneComponent(c, taken)),
  };
}

export function toIndexNodes(nodes: PageNode[]): unknown[] {
  return nodes.map((node) => {
    if (isPageGroup(node)) {
      return { ...node, children: toIndexNodes(node.children) };
    }
    return { id: node.id, type: 'page' };
  });
}

/** Shape accepted by mapAllAreas — a subset of ConfigStore. */
export interface AllAreas {
  pages: PageNode[];
  header: WidgetConfig[];
  footer: WidgetConfig[];
  leftSidebar: WidgetConfig[];
  rightSidebar: WidgetConfig[];
  dialogs: DialogConfig[];
}

/** Apply a component-list mapper across ALL areas simultaneously. */
export function mapAllAreas(
  s: AllAreas,
  mapFn: (components: WidgetConfig[]) => WidgetConfig[],
): AllAreas {
  const pagesWithMappedSections = mapPages(s.pages, (page) => ({
    ...page,
    sections: replacePageSectionWidgets(page, mapFn(getPageChildren(page))),
  }));
  return {
    pages: mapPageGroupChrome(pagesWithMappedSections, mapFn),
    header: mapFn(s.header),
    footer: mapFn(s.footer),
    leftSidebar: mapFn(s.leftSidebar),
    rightSidebar: mapFn(s.rightSidebar),
    dialogs: s.dialogs.map((pop) => ({ ...pop, widgets: mapFn(pop.widgets) })),
  };
}

/** Map a list, handing back the input array when every entry came out identical. */
function mapPreserving<T>(list: T[], fn: (item: T) => T): T[] {
  let changed = false;
  const next = list.map((item) => {
    const mapped = fn(item);
    if (mapped !== item) changed = true;
    return mapped;
  });
  return changed ? next : list;
}

/**
 * One widget-list edit applied to every area in a single pass, reporting the pages
 * whose content actually changed.
 *
 * Differs from `mapAllAreas` in what it leaves alone: a page, group, dialog or shell
 * array the edit did not touch comes back as the very same object, so a batch write
 * that reaches one page hands React one changed page rather than a whole new project.
 * That also makes the dirty-page bookkeeping fall out of the walk, instead of costing
 * a `findOwningPage` sweep per id. `edit` must return the array it was given when it
 * changes nothing — `pruneWidgets` and `duplicateWidgets` both do.
 */
export function editAllAreas(
  s: AllAreas,
  edit: (widgets: WidgetConfig[]) => WidgetConfig[],
): { areas: AllAreas; touchedPageIds: string[] } {
  const touchedPageIds: string[] = [];

  const editPage = (page: PageConfig): PageConfig => {
    let sections: Record<string, WidgetConfig[]> | null = null;
    for (const [sectionId, widgets] of Object.entries(page.sections)) {
      const next = edit(widgets);
      if (next === widgets) continue;
      sections ??= { ...page.sections };
      sections[sectionId] = next;
    }
    if (!sections) return page;
    touchedPageIds.push(page.id);
    return { ...page, sections };
  };

  const editNode = (node: PageNode): PageNode => {
    if (!isPageGroup(node)) return editPage(node);
    const header = node.header === undefined ? undefined : edit(node.header);
    const footer = node.footer === undefined ? undefined : edit(node.footer);
    const children = mapPreserving(node.children, editNode) as PageGroupChild[];
    if (header === node.header && footer === node.footer && children === node.children) return node;
    const next: PageGroupConfig = { ...node, children };
    if (header) next.header = header;
    if (footer) next.footer = footer;
    return next;
  };

  return {
    areas: {
      pages: mapPreserving(s.pages, editNode),
      header: edit(s.header),
      footer: edit(s.footer),
      leftSidebar: edit(s.leftSidebar),
      rightSidebar: edit(s.rightSidebar),
      dialogs: mapPreserving(s.dialogs, (dialog) => {
        const widgets = edit(dialog.widgets);
        return widgets === dialog.widgets ? dialog : { ...dialog, widgets };
      }),
    },
    touchedPageIds,
  };
}

/** Collect every id used across a project: pages, page-groups, dialogs, and all widgets. */
export function collectAllIds(s: AllAreas): Set<string> {
  const acc = new Set<string>();
  const walkNode = (node: PageNode): void => {
    acc.add(node.id);
    if (isPageGroup(node)) {
      collectWidgetIds(node.header, acc);
      collectWidgetIds(node.footer, acc);
      node.children.forEach(walkNode);
    } else {
      for (const widgets of Object.values(node.sections)) collectWidgetIds(widgets, acc);
    }
  };
  s.pages.forEach(walkNode);
  collectWidgetIds(s.header, acc);
  collectWidgetIds(s.footer, acc);
  collectWidgetIds(s.leftSidebar, acc);
  collectWidgetIds(s.rightSidebar, acc);
  for (const dialog of s.dialogs) {
    acc.add(dialog.id);
    collectWidgetIds(dialog.widgets, acc);
  }
  return acc;
}

/**
 * Resolve widget ids to the objects currently holding them, in one pass that stops
 * as soon as every id is accounted for.
 *
 * Deliberately narrower than a classification walk: a caller that only needs the
 * live objects for a known handful of ids — the properties panel re-reads them on
 * every keystroke, since a property write replaces every widget object — must not
 * pay for an index of the whole project to get them. An id that is no longer in the
 * tree is simply absent from the result.
 */
export function findWidgetsByIds(s: AllAreas, ids: ReadonlySet<string>): Map<string, WidgetConfig> {
  const found = new Map<string, WidgetConfig>();
  const walk = (widgets: WidgetConfig[] | undefined): void => {
    for (const widget of widgets ?? []) {
      if (found.size === ids.size) return;
      if (ids.has(widget.id)) found.set(widget.id, widget);
      walk(widget.children as WidgetConfig[] | undefined);
    }
  };
  const walkNode = (node: PageNode): void => {
    if (found.size === ids.size) return;
    if (isPageGroup(node)) {
      walk(node.header);
      walk(node.footer);
      node.children.forEach(walkNode);
    } else {
      for (const widgets of Object.values(node.sections)) walk(widgets);
    }
  };
  walk(s.header);
  walk(s.footer);
  walk(s.leftSidebar);
  walk(s.rightSidebar);
  s.pages.forEach(walkNode);
  for (const dialog of s.dialogs) walk(dialog.widgets);
  return found;
}

/** What a move takes out of a tree: the widgets themselves, and everything
 *  underneath them. A drag started on one row moves the whole selection, so both
 *  sets have to be known before a drop can be called valid. */
export interface MovedWidgets {
  roots: Set<string>;
  descendants: Set<string>;
}

/** `MovedWidgets` for widgets already in hand — for a tree that is not a project,
 *  such as a single component definition, which resolves its own ids. */
export function movedWidgetsOf(widgets: Iterable<WidgetConfig | null | undefined>): MovedWidgets {
  const roots = new Set<string>();
  const descendants = new Set<string>();
  for (const widget of widgets) {
    if (!widget) continue;
    roots.add(widget.id);
    collectWidgetIds(widget.children as WidgetConfig[] | undefined, descendants);
  }
  return { roots, descendants };
}

/** The same, resolving ids against the whole project — one pass for the batch, not
 *  a whole-project search per id. */
export function collectMovedWidgets(s: AllAreas, movedIds: readonly string[]): MovedWidgets {
  return movedWidgetsOf(findWidgetsByIds(s, new Set(movedIds)).values());
}

/** Remove a widget by id from anywhere in a page's sections. */
export function removeComponentFromPage(
  page: PageConfig,
  id: string,
): { page: PageConfig; removed: WidgetConfig | null } {
  let removed: WidgetConfig | null = null;

  const nextPage = mapPageSections(page, (widgets) => {
    if (removed) return widgets;
    const result: WidgetConfig[] = [];
    for (const widget of widgets) {
      if (removed) {
        result.push(widget);
        continue;
      }
      if (widget.id === id) {
        removed = widget;
        continue;
      }
      const nested = removeNode([widget], id);
      if (nested.removed) {
        removed = nested.removed;
        result.push(...nested.arr);
      } else {
        result.push(widget);
      }
    }
    return result;
  });

  return { page: nextPage, removed };
}
