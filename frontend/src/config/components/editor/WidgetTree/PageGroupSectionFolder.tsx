import { FolderSimple } from '@phosphor-icons/react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import {
  makePageGroupAreaId,
  pageGroupSectionDropId,
  pageGroupSectionEmptyDropId,
} from '@shared/constants/editorSentinels';
import type { WidgetConfig } from '@shared/types/config';
import TreeNode from './TreeNode';
import TreeRow from '../../ui/TreeRow';
import type { CSSWithVars, NodeKind } from './types';
import { TreeSearchHighlight } from './TreeSearchHighlight';

interface PageGroupSectionFolderProps {
  groupId: string;
  area: 'header' | 'footer';
  label: string;
  depth: number;
  widgets: WidgetConfig[];
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onCtxMenu: (event: React.MouseEvent, id: string, kind: NodeKind) => void;
}

export default function PageGroupSectionFolder({
  groupId,
  area,
  label,
  depth,
  widgets,
  collapsed,
  onToggle,
  onCtxMenu,
}: PageGroupSectionFolderProps) {
  const dropId = pageGroupSectionDropId(groupId, area);
  const emptyDropId = pageGroupSectionEmptyDropId(groupId, area);
  const { setNodeRef: setRowRef, isOver: isRowOver } = useDroppable({ id: dropId });
  const ctxNodeId = makePageGroupAreaId(groupId, area);
  const isCollapsed = collapsed.has(ctxNodeId);

  return (
    <>
      <TreeRow
        variant="section"
        rowRef={setRowRef}
        depth={depth}
        dropTarget={isRowOver}
        toggle={{ open: !isCollapsed, onClick: () => onToggle(ctxNodeId) }}
        icon={
          <span className="cfg-tree-item__icon">
            <FolderSimple size={14} weight="regular" />
          </span>
        }
        label={
          <span>
            <TreeSearchHighlight text={label} />
          </span>
        }
        onContextMenu={(event) => {
          event.preventDefault();
          onCtxMenu(event, ctxNodeId, 'page-group-section');
        }}
      />

      {!isCollapsed && (
        <SortableContext items={widgets.map((w) => w.id)} strategy={verticalListSortingStrategy}>
          {widgets.length === 0 ? (
            <SectionEmptyDrop dropId={emptyDropId} depth={depth + 1} />
          ) : (
            widgets.map((widget) => (
              <TreeNode
                key={widget.id}
                comp={widget}
                depth={depth + 1}
                collapsed={collapsed}
                onToggle={onToggle}
                onCtxMenu={onCtxMenu}
              />
            ))
          )}
        </SortableContext>
      )}
    </>
  );
}

function SectionEmptyDrop({ dropId, depth }: { dropId: string; depth: number }) {
  const { setNodeRef, isOver } = useDroppable({ id: dropId });
  return (
    <div
      ref={setNodeRef}
      className={`cfg-tree-section-empty${isOver ? ' cfg-tree-section-empty--over' : ''}`}
      style={{ '--tree-depth': depth } as CSSWithVars}
    >
      Empty — drop a component here or right-click
    </div>
  );
}
