/**
 * Where a widget added from the composition preview's context menu lands —
 * the flat-tree counterpart of the page editor's previewInsertTarget.
 *
 * A container hosts the new widget itself, anything else hands off to whatever
 * holds it, and with nothing under the cursor the definition root takes it.
 * Definitions cannot contain component instances, so there are no slot targets;
 * the root is tagged 'area' the way the page editor tags a shell region.
 */

import { isContainerHostType, resolveWidgetMetadata } from '@hmi/registry/widgetRegistry';
import { findComponentById } from '@shared/utils/widgetTree';
import type { ComponentDefinition } from '@shared/types/componentTypes';
import type { WidgetConfig } from '@shared/types/config';
import type { PreviewInsertTarget } from '../editor/LivePreview/previewInsertTarget';
import { componentChildren, findWidgetParent } from './compositionTreeOps';

export function compositionRootTarget(component: ComponentDefinition): PreviewInsertTarget {
  return { kind: 'area', nodeId: component.id, name: component.name };
}

export function widgetLabel(widget: WidgetConfig): string {
  return widget.name || resolveWidgetMetadata(widget.type).name;
}

export function resolveCompositionInsertTarget(
  component: ComponentDefinition,
  selectedId: string | null,
): PreviewInsertTarget {
  if (!selectedId || selectedId === component.id) return compositionRootTarget(component);
  const widget = findComponentById(componentChildren(component), selectedId);
  if (!widget) return compositionRootTarget(component);
  if (isContainerHostType(widget.type)) {
    return { kind: 'container', nodeId: widget.id, name: widgetLabel(widget) };
  }
  const parentId = findWidgetParent(component, selectedId)?.parentId;
  const parent = parentId ? findComponentById(componentChildren(component), parentId) : null;
  if (!parent) return compositionRootTarget(component);
  return { kind: 'container', nodeId: parent.id, name: widgetLabel(parent) };
}
