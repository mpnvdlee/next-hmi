import type {
  WidgetConfig,
  PageConfig,
  PageGroupConfig,
  PageGroupChild,
  PageNode,
  ShellAreaId,
} from '@shared/types/config';
import { SHELL_REGION_IDS, shellSectionIdForRegion } from '@shared/types/config';
import { isContainerHostType, resolveWidgetMetadata } from '@hmi/registry/widgetRegistry';
import { isPageGroup, resolvePageTitle } from '@shared/utils/pageTree';
import { mapPageSections } from '@shared/utils/pageContent';
import {
  EDITOR_NODE_IDS,
  makePageGroupAreaId,
  makePageSectionId,
} from '@shared/constants/editorSentinels';
import { matchesSearchWords, withDotSearchSeparators } from '@shared/utils/search';

type TreeSectionId =
  | typeof EDITOR_NODE_IDS.EVENTS
  | typeof EDITOR_NODE_IDS.HEADER
  | typeof EDITOR_NODE_IDS.FOOTER
  | typeof EDITOR_NODE_IDS.LEFT_SIDEBAR
  | typeof EDITOR_NODE_IDS.RIGHT_SIDEBAR
  | typeof EDITOR_NODE_IDS.PAGES
  | typeof EDITOR_NODE_IDS.DIALOGS;

/** Components in each shell region, keyed by region id. */
export type ShellAreas = Record<ShellAreaId, WidgetConfig[]>;

interface RevealTarget {
  sectionId: TreeSectionId;
  expandIds: string[];
}

// ── Search filter ─────────────────────────────────────────────────────────────

export function filterComponents(
  components: WidgetConfig[],
  query: string,
  ancestorPath = '',
): WidgetConfig[] {
  const wordQuery = withDotSearchSeparators(query);
  const result: WidgetConfig[] = [];
  for (const comp of components) {
    const metadata = resolveWidgetMetadata(comp.type);
    const label = comp.name?.trim() || metadata.name;
    const componentPath = ancestorPath ? `${ancestorPath} / ${label}` : label;
    if (
      matchesSearchWords(wordQuery, [
        componentPath,
        comp.id,
        comp.type,
        metadata.name,
        metadata.category,
        metadata.description,
      ])
    ) {
      result.push(comp);
    } else if (comp.children?.length) {
      const filteredChildren = filterComponents(comp.children, wordQuery, componentPath);
      if (filteredChildren.length > 0) result.push({ ...comp, children: filteredChildren });
    }
  }
  return result;
}

export function filterPage(page: PageConfig, query: string, ancestorPath = ''): PageConfig | null {
  const wordQuery = withDotSearchSeparators(query);
  const title = resolvePageTitle(page.title);
  const pagePath = ancestorPath ? `${ancestorPath} / ${title}` : title;
  const titleMatches = matchesSearchWords(wordQuery, [pagePath, page.id]);
  let anyWidget = titleMatches;
  const filteredSections = mapPageSections(page, (widgets, sectionId) => {
    if (titleMatches) return widgets;
    const sectionPath = `${pagePath} / ${sectionId}`;
    const sectionMatches = matchesSearchWords(wordQuery, sectionPath);
    const filtered = sectionMatches ? widgets : filterComponents(widgets, wordQuery, sectionPath);
    if (sectionMatches || filtered.length > 0) anyWidget = true;
    return filtered;
  });
  return anyWidget ? filteredSections : null;
}

export function filterPageGroup(
  group: PageGroupConfig,
  query: string,
  ancestorPath = '',
): PageGroupConfig | null {
  const wordQuery = withDotSearchSeparators(query);
  const title = resolvePageTitle(group.title);
  const groupPath = ancestorPath ? `${ancestorPath} / ${title}` : title;
  const titleMatches = matchesSearchWords(wordQuery, [groupPath, group.id]);
  if (titleMatches) return group;

  const headerPath = `${groupPath} / Header`;
  const headerMatches = matchesSearchWords(wordQuery, headerPath);
  const filteredHeader = headerMatches
    ? (group.header ?? [])
    : filterComponents(group.header ?? [], wordQuery, headerPath);
  const footerPath = `${groupPath} / Footer`;
  const footerMatches = matchesSearchWords(wordQuery, footerPath);
  const filteredFooter = footerMatches
    ? (group.footer ?? [])
    : filterComponents(group.footer ?? [], wordQuery, footerPath);
  const filteredChildren: PageGroupChild[] = [];
  for (const child of group.children) {
    const filtered = isPageGroup(child)
      ? filterPageGroup(child, wordQuery, groupPath)
      : filterPage(child, wordQuery, groupPath);
    if (filtered) filteredChildren.push(filtered);
  }
  if (
    !headerMatches &&
    filteredHeader.length === 0 &&
    !footerMatches &&
    filteredFooter.length === 0 &&
    filteredChildren.length === 0
  ) {
    return null;
  }
  return { ...group, header: filteredHeader, footer: filteredFooter, children: filteredChildren };
}

// ── Ancestor / collapsible-id walks ───────────────────────────────────────────

function findComponentAncestors(
  components: WidgetConfig[],
  id: string,
  ancestors: string[] = [],
): string[] | null {
  for (const component of components) {
    if (component.id === id) return ancestors;
    if (!component.children?.length) continue;
    const nested = findComponentAncestors(component.children, id, [...ancestors, component.id]);
    if (nested) return nested;
  }
  return null;
}

export function collectContainerIds(components: WidgetConfig[]): string[] {
  const ids: string[] = [];
  for (const component of components) {
    if (isContainerHostType(component.type)) ids.push(component.id);
    if (component.children?.length) ids.push(...collectContainerIds(component.children));
  }
  return ids;
}

function collectPageCollapsibleIds(page: PageConfig): string[] {
  const ids: string[] = [page.id];
  for (const widgets of Object.values(page.sections)) {
    for (const widget of widgets) {
      if (isContainerHostType(widget.type)) {
        ids.push(widget.id);
        if (widget.children?.length) ids.push(...collectContainerIds(widget.children));
      }
    }
  }
  return ids;
}

function collectPageGroupCollapsibleIds(group: PageGroupConfig): string[] {
  const ids: string[] = [group.id];
  for (const child of group.children) {
    if (isPageGroup(child)) ids.push(...collectPageGroupCollapsibleIds(child));
    else ids.push(...collectPageCollapsibleIds(child));
  }
  return ids;
}

export function collectAllCollapsibleIds(
  pages: PageNode[],
  shell: ShellAreas,
  dialogs: { id: string; widgets: WidgetConfig[] }[],
): string[] {
  const ids: string[] = [];

  for (const node of pages) {
    if (isPageGroup(node)) ids.push(...collectPageGroupCollapsibleIds(node));
    else ids.push(...collectPageCollapsibleIds(node));
  }

  for (const region of SHELL_REGION_IDS) {
    ids.push(...collectContainerIds(shell[region]));
  }

  for (const dialog of dialogs) {
    ids.push(dialog.id);
    ids.push(...collectContainerIds(dialog.widgets));
  }

  return ids;
}

// ── Reveal-target lookup ──────────────────────────────────────────────────────

function findInPage(page: PageConfig, id: string, ancestors: string[]): string[] | null {
  if (page.id === id) return ancestors;
  for (const [sectionId, widgets] of Object.entries(page.sections)) {
    if (widgets.some((w) => w.id === id)) {
      return [...ancestors, page.id, makePageSectionId(page.id, sectionId)];
    }
    for (const widget of widgets) {
      if (!widget.children?.length) continue;
      const nested = findComponentAncestors(widget.children, id, [widget.id]);
      if (nested) return [...ancestors, page.id, makePageSectionId(page.id, sectionId), ...nested];
    }
  }
  return null;
}

function findInPageGroup(group: PageGroupConfig, id: string, trail: string[]): string[] | null {
  if (group.id === id) return trail;
  const nextTrail = [...trail, group.id];
  if (group.header) {
    const headerAncestors = findComponentAncestors(group.header, id);
    if (headerAncestors)
      return [...nextTrail, makePageGroupAreaId(group.id, 'header'), ...headerAncestors];
  }
  if (group.footer) {
    const footerAncestors = findComponentAncestors(group.footer, id);
    if (footerAncestors)
      return [...nextTrail, makePageGroupAreaId(group.id, 'footer'), ...footerAncestors];
  }
  for (const child of group.children) {
    const nested = isPageGroup(child)
      ? findInPageGroup(child, id, nextTrail)
      : findInPage(child, id, nextTrail);
    if (nested) return nested;
  }
  return null;
}

function findInPages(pages: PageNode[], id: string): string[] | null {
  for (const node of pages) {
    const found = isPageGroup(node) ? findInPageGroup(node, id, []) : findInPage(node, id, []);
    if (found) return found;
  }
  return null;
}

export function findRevealTarget(
  selectedId: string,
  pages: PageNode[],
  shell: ShellAreas,
  dialogs: { id: string; widgets: WidgetConfig[] }[],
): RevealTarget | null {
  if (selectedId === EDITOR_NODE_IDS.EVENTS) return null;
  if (selectedId === EDITOR_NODE_IDS.PAGES)
    return { sectionId: EDITOR_NODE_IDS.PAGES, expandIds: [] };
  if (selectedId === EDITOR_NODE_IDS.DIALOGS)
    return { sectionId: EDITOR_NODE_IDS.DIALOGS, expandIds: [] };
  for (const region of SHELL_REGION_IDS) {
    const sectionId = shellSectionIdForRegion(region);
    if (selectedId === sectionId) return { sectionId, expandIds: [] };
  }

  for (const region of SHELL_REGION_IDS) {
    const ancestors = findComponentAncestors(shell[region], selectedId);
    if (ancestors) return { sectionId: shellSectionIdForRegion(region), expandIds: ancestors };
  }

  for (const dialog of dialogs) {
    if (dialog.id === selectedId) {
      return { sectionId: EDITOR_NODE_IDS.DIALOGS, expandIds: [] };
    }
    const dialogAncestors = findComponentAncestors(dialog.widgets, selectedId);
    if (dialogAncestors) {
      return { sectionId: EDITOR_NODE_IDS.DIALOGS, expandIds: [dialog.id, ...dialogAncestors] };
    }
  }

  const pageAncestors = findInPages(pages, selectedId);
  if (pageAncestors) return { sectionId: EDITOR_NODE_IDS.PAGES, expandIds: pageAncestors };

  return null;
}
