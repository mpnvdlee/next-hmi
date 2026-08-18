import type { WidgetConfig, PageConfig } from '@shared/types/config';

/** Flat list of every widget in a page, in section order. */
export function getPageChildren(page: PageConfig): WidgetConfig[] {
  return Object.values(page.sections).flat();
}

/** Default section id when a page has no sections yet. Pages always render a 'content' section. */
export const CONTENT_SECTION_ID = 'content' as const;

/** Apply `fn` to each section's widgets and return a new page. */
export function mapPageSections(
  page: PageConfig,
  fn: (widgets: WidgetConfig[], sectionId: string) => WidgetConfig[],
): PageConfig {
  const next: Record<string, WidgetConfig[]> = {};
  for (const [sectionId, widgets] of Object.entries(page.sections)) {
    next[sectionId] = fn(widgets, sectionId);
  }
  return { ...page, sections: next };
}

/**
 * Distribute a flat list of widgets back into the page's sections by id —
 * each widget goes into the section it previously occupied; unknown widgets
 * fall into the default section. Used by `configStore.reorderPageChildren`
 * for the flat tree view's drag-reorder, where the input list mixes widgets
 * from multiple sections and the prior section assignment is the only
 * reliable signal for where each widget should land.
 *
 * Differs from `replacePageSectionWidgets`, which slices positionally using
 * previous section sizes — that variant is for operations that don't preserve
 * widget identity through the call (e.g. `moveNodeToContainer`).
 */
export function distributeToSections(
  page: PageConfig,
  flat: WidgetConfig[],
): Record<string, WidgetConfig[]> {
  const idToSection = new Map<string, string>();
  for (const [sectionId, items] of Object.entries(page.sections)) {
    for (const item of items) idToSection.set(item.id, sectionId);
  }
  const fallback = CONTENT_SECTION_ID;
  const next: Record<string, WidgetConfig[]> = {};
  for (const sectionId of Object.keys(page.sections)) next[sectionId] = [];
  if (!(fallback in next)) next[fallback] = [];
  for (const widget of flat) {
    const sectionId = idToSection.get(widget.id) ?? fallback;
    if (!next[sectionId]) next[sectionId] = [];
    next[sectionId].push(widget);
  }
  return next;
}

/** Append a widget to a specific section (defaults to the page's content section). */
export function appendToSection(
  page: PageConfig,
  widget: WidgetConfig,
  sectionId?: string,
): PageConfig {
  const target = sectionId ?? CONTENT_SECTION_ID;
  const sections = { ...page.sections };
  sections[target] = [...(sections[target] ?? []), widget];
  return { ...page, sections };
}

/**
 * Replace every section's widget list with values from `widgets`, preserving
 * section keys/order. Slices positionally: section i takes its previous size's
 * worth of widgets, and the last section absorbs any excess.
 *
 * Used by `configStore.reorderChildren`, `moveNodeToContainer`, and `_mapAllAreas`
 * — call sites where the input list is the *new* flat content for the page and
 * the prior id→section map can't be trusted (widgets may have moved into the
 * page from elsewhere). Use `distributeToSections` instead when the input
 * preserves widget identity through a reorder.
 */
export function replacePageSectionWidgets(
  page: PageConfig,
  widgets: WidgetConfig[],
): Record<string, WidgetConfig[]> {
  const queue = [...widgets];
  const next: Record<string, WidgetConfig[]> = {};
  const sectionEntries = Object.entries(page.sections);
  for (let i = 0; i < sectionEntries.length; i++) {
    const [sectionId, current] = sectionEntries[i];
    const isLast = i === sectionEntries.length - 1;
    const take = isLast ? queue.length : current.length;
    next[sectionId] = queue.splice(0, take);
  }
  if (sectionEntries.length === 0 && queue.length > 0) {
    next[CONTENT_SECTION_ID] = queue;
  }
  return next;
}
