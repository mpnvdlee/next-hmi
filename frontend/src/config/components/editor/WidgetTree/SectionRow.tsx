import { useDroppable } from '@dnd-kit/core';
import TreeRow from '../../ui/TreeRow';
import { TreeDiagnosticDot, TreeRowActionButton } from '../../ui/TreeAffordances';
import {
  containsSeverityTitle,
  type DiagnosticSeverity,
} from '@config/hooks/useProjectDiagnostics';
import { TreeSearchHighlight } from './TreeSearchHighlight';
import { useDropIndicator } from './useDropIndicator';

interface SectionRowProps {
  label: string;
  icon: string;
  isOpen: boolean;
  onToggle: () => void;
  onAdd: (event: React.MouseEvent) => void;
  addTitle: string;
  selected: boolean;
  onSelect: () => void;
  onCtxMenu?: (event: React.MouseEvent) => void;
  onDoubleClick?: () => void;
  count?: number;
  /** Worst build-diagnostic severity anywhere under this section. */
  severity?: DiagnosticSeverity;
  /** Makes the row a drop target, so a drag can reach the area even when it is
   *  empty or collapsed. */
  dropId?: string;
}

export default function SectionRow({
  label,
  icon,
  isOpen,
  onToggle,
  onAdd,
  addTitle,
  selected,
  onSelect,
  onCtxMenu,
  onDoubleClick,
  count,
  severity,
  dropId,
}: SectionRowProps) {
  const { setNodeRef } = useDroppable({ id: dropId ?? '__no_drop__', disabled: !dropId });
  // The indicator follows the resolved plan, so the row does not offer itself to
  // a drag it would refuse (a page dragged over a shell area).
  const drop = useDropIndicator(dropId ?? '');
  return (
    <TreeRow
      variant="group"
      rowRef={dropId ? setNodeRef : undefined}
      dropTarget={drop.into}
      selected={selected}
      toggle={{ open: isOpen, onClick: onToggle }}
      icon={<span className="cfg-tree-item__icon">{icon}</span>}
      label={
        <span className="cfg-tree-item__label">
          <TreeSearchHighlight text={label} />
        </span>
      }
      onSelect={onSelect}
      onDoubleClick={onDoubleClick}
      onContextMenu={
        onCtxMenu
          ? (event) => {
              event.preventDefault();
              onCtxMenu(event);
            }
          : undefined
      }
    >
      {count !== undefined && count > 0 && <span className="cfg-tree-item__count">{count}</span>}
      {severity && (
        <TreeDiagnosticDot severity={severity} title={containsSeverityTitle(severity)} />
      )}
      <TreeRowActionButton
        title={addTitle}
        onClick={(event) => {
          event.stopPropagation();
          onAdd(event);
        }}
      >
        +
      </TreeRowActionButton>
    </TreeRow>
  );
}
