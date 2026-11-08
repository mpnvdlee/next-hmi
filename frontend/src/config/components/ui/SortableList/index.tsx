import type { ReactNode } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { useSortableRow } from './useSortableRow';
import './style.css';

interface ListProps {
  /** One stable id per row, in order — a row's index will do when the list
   *  is keyed by index anyway. */
  ids: string[];
  /** A row dropped elsewhere: its old and new position in `ids`. */
  onMove: (from: number, to: number) => void;
  children: ReactNode;
}

/** A list whose rows are reordered by their `⋮⋮` grip — by mouse, or from the
 *  keyboard: focus the grip, Space to lift, the arrows to move, Space to drop. */
export default function SortableList({ ids, onMove, children }: ListProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={({ active, over }) => {
        const from = ids.indexOf(String(active.id));
        const to = over ? ids.indexOf(String(over.id)) : -1;
        if (from >= 0 && to >= 0 && from !== to) onMove(from, to);
      }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}

/** One row of a `SortableList`, its grip in the gutter before the row's box. */
export function SortableRow({ id, children }: { id: string; children: ReactNode }) {
  const { rowProps, grip } = useSortableRow(id);
  return (
    <div className="cfg-sortable-row" {...rowProps}>
      {grip}
      <div className="cfg-sortable-row__body">{children}</div>
    </div>
  );
}
