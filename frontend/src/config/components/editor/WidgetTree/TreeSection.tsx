import { Fragment, type ReactNode } from 'react';
import { FolderSimple } from '@phosphor-icons/react';
import { useDroppable } from '@dnd-kit/core';
import TreeRow from '../../ui/TreeRow';
import { TreeSearchHighlight } from './TreeSearchHighlight';
import type { CSSWithVars } from './types';

interface TreeSectionProps {
  label: string;
  depth: number;
  collapsed: boolean;
  onToggle: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
  /** Droppable id on the section's own row — dropping there appends. */
  rowDropId: string;
  /** Droppable id on the placeholder shown while the section is empty. */
  emptyDropId: string;
  children: ReactNode;
  isEmpty: boolean;
}

/**
 * A named group of widgets inside a tree row's subtree: a page's
 * header/content/footer, or one slot of a reusable-component instance. Both
 * carry the same affordances (collapse, drop target, right-click to add), so
 * they share this row rather than each growing their own.
 */
export default function TreeSection({
  label,
  depth,
  collapsed,
  onToggle,
  onContextMenu,
  rowDropId,
  emptyDropId,
  children,
  isEmpty,
}: TreeSectionProps) {
  const { setNodeRef, isOver } = useDroppable({ id: rowDropId });
  return (
    <Fragment>
      <TreeRow
        variant="section"
        rowRef={setNodeRef}
        depth={depth}
        dropTarget={isOver}
        toggle={{ open: !collapsed, onClick: onToggle }}
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
          onContextMenu(event);
        }}
      />
      {!collapsed && isEmpty && <SectionEmptyDrop dropId={emptyDropId} depth={depth + 1} />}
      {!collapsed && !isEmpty && children}
    </Fragment>
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
