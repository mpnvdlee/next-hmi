import type { MouseEventHandler, ReactNode, Ref } from 'react';
import type { CSSWithVars } from '@shared/types/style';
import { selectionModifiers, type SelectionModifiers } from '@shared/utils/domEvent';
import { TreeToggleButton } from '../TreeAffordances';

interface TreeRowProps {
  /** Indentation level; maps to the `--tree-depth` CSS var consumed by config.css. */
  depth?: number;
  /** `group` = bold section/root row. `page` = WidgetTree page/dialog row. `section` = non-selectable droppable row (WidgetTree header/footer/page sections). */
  variant?: 'group' | 'page' | 'section';
  selected?: boolean;
  /** Highlights the row as an active dnd-kit drop target (`--section-over`). */
  dropTarget?: boolean;
  /** Draws the insert line above or below the row while a drag hovers its edge. */
  dropEdge?: 'top' | 'bottom';
  /** Dims the row while it waits to be moved by the next paste. */
  cut?: boolean;
  /** Dims the row for placeholder "+ Add X" rows that aren't real tree nodes. */
  dimmed?: boolean;
  /** Omit entirely for leaf rows that can't collapse — renders an empty spacer instead. */
  toggle?: { open: boolean; onClick: () => void };
  icon?: ReactNode;
  /** Full label content, e.g. `<span className="cfg-tree-item__label">Name</span>` or a `TreeRenameInput`. */
  label: ReactNode;
  /** Everything rendered after the label: count badges, status dots, action buttons, drag handles. */
  children?: ReactNode;
  /** Rows that cannot multi-select ignore the argument and keep a zero-arg handler. */
  onSelect?: (mods: SelectionModifiers) => void;
  onContextMenu?: MouseEventHandler<HTMLDivElement>;
  onDoubleClick?: () => void;
  rowRef?: Ref<HTMLDivElement>;
  style?: CSSWithVars;
}

export default function TreeRow({
  depth = 0,
  variant,
  selected,
  dropTarget,
  dropEdge,
  cut,
  dimmed,
  toggle,
  icon,
  label,
  children,
  onSelect,
  onContextMenu,
  onDoubleClick,
  rowRef,
  style,
}: TreeRowProps) {
  const className = [
    'cfg-tree-item',
    variant === 'group' && 'cfg-tree-item--group',
    variant === 'page' && 'cfg-tree-item--page',
    variant === 'section' && 'cfg-tree-item--section',
    dropTarget && 'cfg-tree-item--section-over',
    dropEdge === 'top' && 'cfg-tree-item--drop-top',
    dropEdge === 'bottom' && 'cfg-tree-item--drop-bottom',
    cut && 'cfg-tree-item--cut',
    selected && 'cfg-tree-item--selected',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={rowRef}
      className={className}
      style={
        {
          '--tree-depth': depth,
          ...(dimmed && { opacity: 0.6, cursor: 'pointer' }),
          ...style,
        } as CSSWithVars
      }
      onClick={onSelect && ((e) => onSelect(selectionModifiers(e)))}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
    >
      <span className="cfg-tree-item__toggle-slot">
        {toggle && (
          <TreeToggleButton
            open={toggle.open}
            onClick={(e) => {
              e.stopPropagation();
              toggle.onClick();
            }}
          />
        )}
      </span>
      {icon}
      {label}
      {children}
    </div>
  );
}
