import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { WidgetConfig } from '@shared/types/config';
import TreeNode from './TreeNode';
import { useDropIndicator } from './useDropIndicator';
import type { NodeKind } from './types';

interface AreaWidgetListProps {
  /** Drop id for the empty placeholder — the area's own id. */
  dropId?: string;
  components: WidgetConfig[];
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onCtxMenu: (event: React.MouseEvent, id: string, kind: NodeKind) => void;
  depth?: number;
}

/** The widget rows of one area. Dragging is owned by the tree root — the whole
 *  tree is a single drag context so a node can move between parents. */
export default function AreaWidgetList({
  dropId,
  components,
  collapsed,
  onToggle,
  onCtxMenu,
  depth = 1,
}: AreaWidgetListProps) {
  if (components.length === 0) {
    return <EmptyAreaDrop dropId={dropId} />;
  }

  return (
    <SortableContext
      items={components.map((comp) => comp.id)}
      strategy={verticalListSortingStrategy}
    >
      {components.map((comp) => (
        <TreeNode
          key={comp.id}
          comp={comp}
          depth={depth}
          collapsed={collapsed}
          onToggle={onToggle}
          onCtxMenu={onCtxMenu}
        />
      ))}
    </SortableContext>
  );
}

function EmptyAreaDrop({ dropId }: { dropId?: string }) {
  const { setNodeRef } = useDroppable({ id: dropId ?? '__no_drop__', disabled: !dropId });
  // Lit by the resolved plan rather than by raw hover, so it never invites a
  // drag the drop would refuse.
  const drop = useDropIndicator(dropId ?? '');
  return (
    <div
      ref={dropId ? setNodeRef : undefined}
      className={`cfg-tree-section-empty${drop.into ? ' cfg-tree-section-empty--over' : ''}`}
    >
      Empty — right-click or use + to add
    </div>
  );
}
