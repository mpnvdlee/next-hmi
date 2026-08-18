import { useConfigStore } from '@shared/store/configStore';
import type { ShellAreaId, WidgetConfig } from '@shared/types/config';
import {
  parsePageGroupAreaId,
  parsePageSectionId,
  parseWidgetSlotId,
} from '@shared/constants/editorSentinels';
import type { NodeKind } from './types';

/** The order a batch landing on one target has to be inserted in: a `leaf` target
 *  puts each node *directly* after it, so a list inserted in document order beside
 *  one would end up reversed. Every other kind appends and keeps the order given. */
export function batchInsertOrder<T>(nodes: readonly T[], kind: NodeKind | 'root'): readonly T[] {
  return kind === 'leaf' ? [...nodes].reverse() : nodes;
}

/** Append an already-built component to the correct parent, resolving the store
 *  action from the tree node's kind. Shared by the context-menu add flows, the
 *  widget selector drawer, and the live preview's own context menu. */
export function insertComponentInto(
  store: ReturnType<typeof useConfigStore.getState>,
  kind: NodeKind,
  nodeId: string,
  comp: WidgetConfig,
) {
  if (kind === 'page') store.addComponentToPage(nodeId, comp);
  else if (kind === 'page-section') {
    const [pageId, sectionId] = parsePageSectionId(nodeId);
    store.addComponentToPageSection(pageId, sectionId, comp);
  } else if (kind === 'page-group-section') {
    const [groupId, area] = parsePageGroupAreaId(nodeId);
    store.addComponentToPageGroupArea(groupId, area, comp);
  } else if (kind === 'widget-slot') {
    const [widgetId, slot] = parseWidgetSlotId(nodeId);
    store.addComponentToWidgetSlot(widgetId, slot, comp);
  } else if (kind === 'area') store.addComponentToArea(nodeId as ShellAreaId, comp);
  else if (kind === 'dialog-page') store.addComponentToDialog(nodeId, comp);
  else store.addComponentToContainer(nodeId, comp);
}
