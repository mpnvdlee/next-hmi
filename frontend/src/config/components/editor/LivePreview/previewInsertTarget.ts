/**
 * Where a widget added from the live preview's own context menu lands.
 *
 * Right-clicking in the preview picks the same node a left-click would select,
 * so the insertion target is derived from that node: a container hosts the new
 * widget itself, anything else hands off to whatever holds it (a container, a
 * page section, a shell area, a dialog, a page-group's chrome). With nothing
 * under the cursor the area currently shown in the preview takes it.
 */

import type { AllAreas } from '@shared/store/configStoreHelpers';
import {
  makePageGroupAreaId,
  makePageSectionId,
  makeWidgetSlotId,
  SHELL_AREA_LABELS,
} from '@shared/constants/editorSentinels';
import { hasSlotSections, widgetSlots } from '@hmi/registry/widgetRegistry';
import { resolveChildSlot, slotTargetLabel } from '@hmi/components/ComponentSlot/slotKey';
import {
  regionForShellSectionId,
  shellSectionIdForRegion,
  type ShellRegionId,
} from '@shared/types/config';
import { findPageNodeById, isPageGroup, resolvePageTitle } from '@shared/utils/pageTree';
import { findParentInfo } from '../WidgetTree/treeUtils';
import { findWidgetEverywhere, kindForSelectedId } from '../WidgetTree/clipboardDispatch';
import type { NodeKind } from '../WidgetTree/types';

export interface PreviewInsertTarget {
  nodeId: string;
  kind: NodeKind;
  /** Shown in the menu and the widget selector so the target is never implicit. */
  name: string;
}

function pageTitleOf(project: AllAreas, pageId: string): string {
  const node = findPageNodeById(project.pages, pageId);
  return node ? resolvePageTitle(node.title) : pageId;
}

function dialogTarget(project: AllAreas, dialogId: string): PreviewInsertTarget | null {
  const dialog = project.dialogs.find((d) => d.id === dialogId);
  if (!dialog) return null;
  return { kind: 'dialog-page', nodeId: dialog.id, name: resolvePageTitle(dialog.title) };
}

function areaTarget(region: ShellRegionId): PreviewInsertTarget {
  return {
    kind: 'area',
    nodeId: region,
    name: SHELL_AREA_LABELS[shellSectionIdForRegion(region)] ?? region,
  };
}

/** `slotHint` names the slot to land in when the container is a multi-slot
 *  component instance; without one the definition's first slot takes it. */
function containerTarget(
  project: AllAreas,
  containerId: string,
  slotHint?: string,
): PreviewInsertTarget {
  const widget = findWidgetEverywhere(project, containerId);
  const name = widget?.name ?? containerId;
  const type = widget?.type ?? '';
  if (hasSlotSections(type)) {
    const slot = resolveChildSlot(slotHint, widgetSlots(type))!;
    return {
      kind: 'widget-slot',
      nodeId: makeWidgetSlotId(containerId, slot),
      name: slotTargetLabel(name, slot),
    };
  }
  return { kind: 'container', nodeId: containerId, name };
}

/** The host of an existing widget — used when the widget itself cannot take children. */
function parentTarget(project: AllAreas, widgetId: string): PreviewInsertTarget | null {
  const parent = findParentInfo(project, widgetId);
  if (!parent) return null;
  switch (parent.kind) {
    case 'container':
      return containerTarget(project, parent.parentId, parent.siblings[parent.index]?.slot);
    case 'shell-area':
      return areaTarget(parent.region);
    case 'dialog':
      return dialogTarget(project, parent.dialogId);
    case 'page-section':
      return {
        kind: 'page-section',
        nodeId: makePageSectionId(parent.pageId, parent.sectionId),
        name: pageTitleOf(project, parent.pageId),
      };
    case 'page-group-chrome':
      return {
        kind: 'page-group-section',
        nodeId: makePageGroupAreaId(parent.groupId, parent.area),
        name: `${pageTitleOf(project, parent.groupId)} ${
          parent.area === 'header' ? 'Header' : 'Footer'
        }`,
      };
  }
}

/** The area the preview is currently showing: a shell region, a dialog, or a page. */
function previewAreaTarget(project: AllAreas, previewAreaId: string): PreviewInsertTarget | null {
  const region = regionForShellSectionId(previewAreaId);
  if (region) return areaTarget(region);
  const dialog = dialogTarget(project, previewAreaId);
  if (dialog) return dialog;
  const page = findPageNodeById(project.pages, previewAreaId);
  if (page && !isPageGroup(page)) {
    return { kind: 'page', nodeId: page.id, name: resolvePageTitle(page.title) };
  }
  return null;
}

export function resolvePreviewInsertTarget(
  project: AllAreas,
  selectedId: string | null,
  previewAreaId: string,
): PreviewInsertTarget | null {
  const resolved = selectedId ? kindForSelectedId(project, selectedId) : null;
  switch (resolved?.kind) {
    case 'container':
      return containerTarget(project, resolved.nodeId);
    case 'leaf':
      return parentTarget(project, resolved.nodeId) ?? previewAreaTarget(project, previewAreaId);
    case 'page':
      return { kind: 'page', nodeId: resolved.nodeId, name: pageTitleOf(project, resolved.nodeId) };
    case 'dialog-page':
      return dialogTarget(project, resolved.nodeId);
    case 'area':
      return areaTarget(resolved.nodeId as ShellRegionId);
    default:
      return previewAreaTarget(project, previewAreaId);
  }
}
