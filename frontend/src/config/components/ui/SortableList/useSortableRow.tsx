import type { CSSProperties } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripIcon } from '../actionIcons';

/** One row of a `SortableList`: the props for the element that moves, and the
 *  grip that moves it — for a row that places the grip itself (a table cell, a
 *  line inside a field box). */
export function useSortableRow(id: string) {
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  return {
    rowProps: {
      ref: setNodeRef,
      // Up and down only: the row never leaves its column.
      style: {
        '--sortable-transform': transform ? CSS.Translate.toString({ ...transform, x: 0 }) : 'none',
        '--sortable-transition': transition ?? 'none',
      } as CSSProperties,
      'data-dragging': isDragging || undefined,
    },
    grip: (
      <button
        type="button"
        ref={setActivatorNodeRef}
        className="cfg-sortable-grip"
        {...attributes}
        {...listeners}
        title="Drag to reorder"
        aria-label="Drag to reorder"
        // The row's own click (open, select) is not the grip's. Its keys must
        // still bubble: a lifted row is moved by keys the window listens for.
        onClick={(e) => e.stopPropagation()}
      >
        <GripIcon />
      </button>
    ),
  };
}
