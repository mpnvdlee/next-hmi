/**
 * CompositionPreview — center panel for /config/components.
 *
 * Renders a reusable component's widget tree directly using WidgetRenderer.
 * Wraps in PreviewContext so widgets get selection overlays.
 * Also provides InputScopeContext with mock/empty values so widgets render.
 */

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import '@hmi/styles/hmi.css';
import '../editor/LivePreview/style.css';
import type { ComponentDefinition } from '@shared/types/componentTypes';
import type { WidgetConfig } from '@shared/types/config';
import type { CSSWithVars } from '@shared/types/style';
import { HmiScopeContext } from '@hmi/context/HmiScopeContext';
import { PreviewContext } from '@shared/context/PreviewContext';
import { InputScopeContext } from '@hmi/context/InputScopeContext';
import WidgetRenderer from '@hmi/components/WidgetRenderer';
import { defaultValueFor } from '@hmi/utils/propertySourceRegistry';
import { primaryType } from '@shared/utils/valueTypes';
import { findComponentById } from '@shared/utils/widgetTree';
import { NO_MODIFIERS, selectionModifiers, type SelectionModifiers } from '@shared/utils/domEvent';
import PreviewContextMenu from '../editor/LivePreview/PreviewContextMenu';
import type { PreviewInsertTarget } from '../editor/LivePreview/previewInsertTarget';
import type { NodeKind } from '../editor/WidgetTree/types';
import { componentChildren } from './compositionTreeOps';
import { resolveCompositionInsertTarget, widgetLabel } from './compositionInsertTarget';
import CompositionTabBar from './CompositionTabBar';
import ConfigWorkspace from '../ui/ConfigWorkspace';

interface CompositionPreviewProps {
  component: ComponentDefinition;
  /** Every selected widget — the ring is drawn on all of them. The definition's own
   *  id in here means the root is selected. */
  selectedIds: readonly string[];
  /** A canvas click, with its modifiers. Ctrl/cmd extends the selection; there is
   *  no canvas equivalent of a shift range, so `range` is never set here. */
  onSelect: (id: string | null, mods: SelectionModifiers) => void;
  onUpdate: (patch: Partial<ComponentDefinition>) => void;
  /** Context-menu verb, dispatched by ComponentsView like the tree's. */
  onAction: (action: string, nodeId: string, kind: NodeKind) => void;
}

/** Canvas size the editor falls back to when a definition carries no explicit
 *  width or height, in pixels. Kept out of the persisted JSON — a component
 *  only stores a dimension once it is edited away from this. */
const DEFAULT_PREVIEW_SIZE = 400;

interface PreviewCtxMenu {
  x: number;
  y: number;
  target: PreviewInsertTarget;
  widget: { id: string; name: string } | null;
}

export default function CompositionPreview({
  component,
  selectedIds,
  onSelect,
  onUpdate,
  onAction,
}: CompositionPreviewProps) {
  const [ctxMenu, setCtxMenu] = useState<PreviewCtxMenu | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  // Build mock property values so the preview renders gracefully
  const mockProperties = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(component.componentProperties).map(([key, schema]) => [
          key,
          schema.defaultValue ?? defaultValueFor(primaryType(schema.type)),
        ]),
      ),
    [component.componentProperties],
  );
  const inputScopeValue = useMemo(() => ({ properties: mockProperties }), [mockProperties]);

  // Apply the selection ring after DOM mutations so CSS sees the correct element.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.classList.remove('widget-preview-canvas--selected-root');
    canvas
      .querySelectorAll('.hmi-preview-node--selected')
      .forEach((el) => el.classList.remove('hmi-preview-node--selected'));
    for (const id of selectedIds) {
      const wrapper = canvas.querySelector(`[data-widget-id="${CSS.escape(id)}"]`);
      if (wrapper) wrapper.classList.add('hmi-preview-node--selected');
      else if (id === component.id) canvas.classList.add('widget-preview-canvas--selected-root');
    }
  }, [selectedIds, component.id]);

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // Find [data-widget-id] in the click path
    const target = e.target as HTMLElement;
    const node = target.closest('[data-widget-id]');
    if (node) {
      e.stopPropagation();
      const id = node.getAttribute('data-widget-id');
      // Only the ctrl/cmd toggle rides along: a Shift range is a tree-order slice,
      // which is not the order the canvas shows — the page editor's preview reports
      // the same way.
      if (id) onSelect(id, { toggle: selectionModifiers(e).toggle, range: false });
      return;
    }

    // Clicking empty preview canvas selects the component root in the tree.
    onSelect(null, NO_MODIFIERS);
  };

  /** Right-click selects what a left-click would, then offers the same menu the
   *  page editor's preview shows. */
  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const node = (e.target as HTMLElement).closest('[data-widget-id]');
    const clickedId = node?.getAttribute('data-widget-id') ?? null;
    // Right-clicking inside the selection keeps it, so a menu verb acts on
    // everything the canvas shows as selected.
    if (!clickedId || !selectedIds.includes(clickedId)) onSelect(clickedId, NO_MODIFIERS);
    const widget = clickedId ? findComponentById(componentChildren(component), clickedId) : null;
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      target: resolveCompositionInsertTarget(component, widget?.id ?? null),
      widget: widget ? { id: widget.id, name: widgetLabel(widget) } : null,
    });
  };

  const handleMenuAction = (action: string) => {
    if (!ctxMenu) return;
    const { target, widget } = ctxMenu;
    if (action === 'copy' || action === 'cut' || action === 'delete') {
      if (!widget) return;
      onAction(action, widget.id, 'leaf');
      return;
    }
    onAction(action, target.nodeId, target.kind);
  };

  const previewWidth = component.width ?? DEFAULT_PREVIEW_SIZE;
  const previewHeight = component.height ?? DEFAULT_PREVIEW_SIZE;
  const wrapperStyle: CSSWithVars = {
    '--component-preview-width': `${previewWidth}px`,
    '--component-preview-height': `${previewHeight}px`,
  };

  function updateDimension(dimension: 'width' | 'height', value: string) {
    if (value === '') {
      onUpdate({ [dimension]: null });
      return;
    }
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) {
      onUpdate({ [dimension]: parsed });
    }
  }

  return (
    <ConfigWorkspace
      title="Components"
      flush
      className="widget-preview-container"
      actions={
        <div className="component-preview-size" role="group" aria-label="Preview size">
          <label className="component-preview-size__field">
            <span>Width</span>
            <input
              className="component-preview-size__input cfg-prop-input cfg-prop-input--tall cfg-header-control"
              type="number"
              min={1}
              step={1}
              value={previewWidth}
              onChange={(e) => updateDimension('width', e.target.value)}
              aria-label="Preview width in pixels"
            />
          </label>
          <label className="component-preview-size__field">
            <span>Height</span>
            <input
              className="component-preview-size__input cfg-prop-input cfg-prop-input--tall cfg-header-control"
              type="number"
              min={1}
              step={1}
              value={previewHeight}
              onChange={(e) => updateDimension('height', e.target.value)}
              aria-label="Preview height in pixels"
            />
          </label>
        </div>
      }
    >
      <CompositionTabBar />

      <div
        className="editor-preview-scroller"
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      >
        <div className="widget-preview-wrapper" style={wrapperStyle}>
          <div ref={canvasRef} className="widget-preview-canvas">
            <HmiScopeContext.Provider value="runtime:widget-preview">
              <InputScopeContext.Provider value={inputScopeValue}>
                <PreviewContext.Provider value={true}>
                  {(component.children as WidgetConfig[]).map((child) => (
                    <WidgetRenderer key={child.id} node={child} />
                  ))}
                </PreviewContext.Provider>
              </InputScopeContext.Provider>
            </HmiScopeContext.Provider>
          </div>
        </div>
      </div>

      {ctxMenu && (
        <PreviewContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          target={ctxMenu.target}
          widget={ctxMenu.widget}
          onClose={() => setCtxMenu(null)}
          onAction={handleMenuAction}
        />
      )}
    </ConfigWorkspace>
  );
}
