import { useState, type ReactNode } from 'react';
import AddButton from '@config/components/ui/AddButton';
import { FieldActions, FieldHeaderActions } from '@config/components/ui/FieldGroup';
import { ExpandIcon } from '@config/components/ui/actionIcons';
import SortableList from '@config/components/ui/SortableList';
import { useSortableRow } from '@config/components/ui/SortableList/useSortableRow';
import { arrayMove } from '@dnd-kit/sortable';
import ListEditorDrawer, { type ListEditorDrawerProps } from './ListEditorDrawer';
import './style.css';

interface Props<T> extends Omit<ListEditorDrawerProps<T>, 'onClose' | 'focusIndex'> {
  /** One element's line in the panel, after its grip. */
  line: (item: T) => ReactNode;
  /** What the panel shows for an empty list. */
  empty: string;
}

/** A list edited in the panel's drawer: in the panel one line per element,
 *  reordered by its `⋮⋮` grip, a click opening the drawer on that element and
 *  the field's `⤢` on all of them; `+ Add` sits in the field's header. */
export default function PanelList<T>({ line, empty, ...drawer }: Props<T>) {
  const { items, onChange, newItem, noun } = drawer;
  // The element the drawer opens on — `'all'` from the `⤢` — or null while it is closed.
  const [focus, setFocus] = useState<number | 'all' | null>(null);

  return (
    <div className="cfg-panel-list">
      <FieldHeaderActions>
        <AddButton
          title={`Add ${noun}`}
          onClick={() => {
            onChange([...items, newItem()]);
            setFocus(items.length);
          }}
        />
      </FieldHeaderActions>
      {items.length > 0 && (
        <FieldActions>
          <button
            type="button"
            className="cfg-row-action-btn cfg-row-action-btn--stretch"
            title="Expand in drawer"
            onClick={() => setFocus('all')}
          >
            <ExpandIcon />
          </button>
        </FieldActions>
      )}
      {items.length === 0 && <div className="cfg-items-input__empty">{empty}</div>}
      <SortableList
        ids={items.map((_, idx) => String(idx))}
        onMove={(from, to) => onChange(arrayMove(items, from, to))}
      >
        {items.map((item, idx) => (
          <PanelListRow key={idx} id={String(idx)} noun={noun} onOpen={() => setFocus(idx)}>
            {line(item)}
          </PanelListRow>
        ))}
      </SortableList>
      {focus !== null && (
        <ListEditorDrawer
          {...drawer}
          focusIndex={focus === 'all' ? undefined : focus}
          onClose={() => setFocus(null)}
        />
      )}
    </div>
  );
}

function PanelListRow({
  id,
  noun,
  onOpen,
  children,
}: {
  id: string;
  noun: string;
  onOpen: () => void;
  children: ReactNode;
}) {
  const { rowProps, grip } = useSortableRow(id);
  return (
    <div
      {...rowProps}
      role="button"
      tabIndex={0}
      title={`Edit ${noun}`}
      className="cfg-panel-list__row cfg-sortable-item"
      onClick={onOpen}
      onKeyDown={(e) => {
        // Keys on the grip lift and move the row; only the row's own open it.
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      {grip}
      {children}
    </div>
  );
}
