import { useCallback, useMemo } from 'react';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  hasSlotSections,
  isContainerHostType,
  resolveWidgetMetadata,
  widgetSlots,
} from '@hmi/registry/widgetRegistry';
import { groupChildrenBySlot, slotLabel } from '@hmi/components/ComponentSlot/slotKey';
import {
  makeWidgetSlotId,
  widgetSlotEmptyDropId,
  widgetSlotRowDropId,
} from '@shared/constants/editorSentinels';
import type { WidgetConfig } from '@shared/types/config';
import TreeRow from '../../ui/TreeRow';
import WidgetIcon from '../../ui/WidgetIcon';
import { TreeDiagnosticDot } from '../../ui/TreeAffordances';
import {
  containsSeverityTitle,
  subtreeSeverity,
  useWidgetSeverities,
} from '@config/hooks/useProjectDiagnostics';
import { useIsCut } from './cutState';
import { useDropIndicator } from './useDropIndicator';
import { useTreeSelection } from './treeSelectionContext';
import { TreeSearchHighlight } from './TreeSearchHighlight';
import TreeSection from './TreeSection';
import type { CSSWithVars, NodeKind } from './types';

interface TreeNodeProps {
  comp: WidgetConfig;
  depth: number;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onCtxMenu: (event: React.MouseEvent, id: string, kind: NodeKind) => void;
}

export default function TreeNode({ comp, depth, collapsed, onToggle, onCtxMenu }: TreeNodeProps) {
  const { selectedIds, selectRow } = useTreeSelection();
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: comp.id,
  });

  const isContainer = isContainerHostType(comp.type);
  const displayName = comp.name?.trim() || resolveWidgetMetadata(comp.type).name;
  const isCollapsed = collapsed.has(comp.id);
  const isSelected = selectedIds.has(comp.id);
  const isCut = useIsCut(comp.id);
  const drop = useDropIndicator(comp.id);
  const children = useMemo(() => comp.children ?? [], [comp.children]);

  // A reusable-component instance addressing its slots individually shows its
  // children grouped under one named section per slot.
  const slots = widgetSlots(comp.type);
  const slotGroups = useMemo(
    () => (hasSlotSections(comp.type) ? groupChildrenBySlot(children, slots) : null),
    [comp.type, children, slots],
  );

  const widgetSeverities = useWidgetSeverities();
  const severity = useMemo(() => subtreeSeverity(comp, widgetSeverities), [comp, widgetSeverities]);
  const ownSeverity = widgetSeverities.get(comp.id);

  const rowStyle: CSSWithVars = {
    transform: CSS.Transform.toString(transform),
    transition: transition ?? undefined,
    '--dragging-opacity': isDragging ? '0.4' : '1',
  };

  const renderChild = useCallback(
    (child: WidgetConfig, childDepth: number) => (
      <TreeNode
        key={child.id}
        comp={child}
        depth={childDepth}
        collapsed={collapsed}
        onToggle={onToggle}
        onCtxMenu={onCtxMenu}
      />
    ),
    [collapsed, onToggle, onCtxMenu],
  );

  return (
    <div style={rowStyle} className="editor-tree-row">
      <TreeRow
        rowRef={setNodeRef}
        depth={depth}
        selected={isSelected}
        cut={isCut}
        dropTarget={drop.into}
        dropEdge={drop.edge}
        toggle={isContainer ? { open: !isCollapsed, onClick: () => onToggle(comp.id) } : undefined}
        icon={
          <span className="cfg-tree-item__icon cfg-tree-item__icon--svg">
            <WidgetIcon type={comp.type} />
          </span>
        }
        label={
          <span className="cfg-tree-item__label">
            <TreeSearchHighlight text={displayName} />
          </span>
        }
        onSelect={(mods) => selectRow(comp.id, mods)}
        onContextMenu={(event) => {
          event.preventDefault();
          onCtxMenu(event, comp.id, isContainer ? 'container' : 'leaf');
        }}
      >
        {severity && (
          <TreeDiagnosticDot
            severity={severity}
            title={
              ownSeverity
                ? `This widget has ${severity === 'error' ? 'an error' : 'a warning'}`
                : containsSeverityTitle(severity)
            }
          />
        )}
        <span className="cfg-tree-item__handle" {...attributes} {...listeners}>
          ⠿
        </span>
      </TreeRow>

      {isContainer && !isCollapsed && (children.length > 0 || slotGroups) && (
        <SortableContext
          items={children.map((child) => child.id)}
          strategy={verticalListSortingStrategy}
        >
          {slotGroups
            ? slots.map((slot) => (
                <TreeSection
                  key={slot}
                  label={slotLabel(slot)}
                  depth={depth + 1}
                  collapsed={collapsed.has(makeWidgetSlotId(comp.id, slot))}
                  onToggle={() => onToggle(makeWidgetSlotId(comp.id, slot))}
                  onContextMenu={(event) =>
                    onCtxMenu(event, makeWidgetSlotId(comp.id, slot), 'widget-slot')
                  }
                  rowDropId={widgetSlotRowDropId(comp.id, slot)}
                  emptyDropId={widgetSlotEmptyDropId(comp.id, slot)}
                  isEmpty={slotGroups[slot].length === 0}
                >
                  {slotGroups[slot].map((child) => renderChild(child, depth + 2))}
                </TreeSection>
              ))
            : children.map((child) => renderChild(child, depth + 1))}
        </SortableContext>
      )}
    </div>
  );
}
