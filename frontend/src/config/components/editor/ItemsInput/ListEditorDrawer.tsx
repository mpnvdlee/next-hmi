import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import FieldGroup from '@config/components/ui/FieldGroup';
import { FieldPathContext } from '@config/components/ui/FieldGroup/fieldPathContext';
import { ClearIcon } from '@config/components/ui/actionIcons';
import AddButton from '@config/components/ui/AddButton';
import SortableList, { SortableRow } from '@config/components/ui/SortableList';
import { arrayMove } from '@dnd-kit/sortable';
import FieldDrawer from '../PropertiesPanel/FieldDrawer';
import { KindLabel, PreviewText } from '../PropertySourceEditor/editors/shared';
import './style.css';

export interface ListEditorDrawerProps<T> {
  /** The list being edited: "Columns". */
  title: string;
  /** One element, for the add control and the empty list: "column". */
  noun: string;
  items: T[];
  /** Every edit is applied at once, so the canvas follows while the drawer is open. */
  onChange: (items: T[]) => void;
  newItem: () => T;
  /** One row's name, collapsed or open: "1 Id · Fill · left". */
  itemTitle: (item: T, idx: number) => ReactNode;
  /** One row's fields. */
  renderItem: (item: T, update: (patch: Partial<T>) => void, idx: number) => ReactNode;
  onClose: () => void;
  /** The row the drawer opens on, alone expanded and scrolled into view;
   *  absent, every row opens expanded — or collapsed, with `openCollapsed`. */
  focusIndex?: number;
  /** Open on all rows (no `focusIndex`) with every row collapsed to its line. */
  openCollapsed?: boolean;
}

/** A list edited in the properties panel's own `⤢` drawer, in the shell of a
 *  `$switch` case list: the add control behind the title, and one collapsible
 *  row per element that carries its own fields, moved by its `⋮⋮` grip and
 *  removed with its `×`. */
export default function ListEditorDrawer<T>({
  title,
  noun,
  items,
  onChange,
  newItem,
  itemTitle,
  renderItem,
  onClose,
  focusIndex,
  openCollapsed = false,
}: ListEditorDrawerProps<T>) {
  const path = useContext(FieldPathContext);
  const listRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Set<number>>(
    () =>
      new Set(
        focusIndex !== undefined ? [focusIndex] : openCollapsed ? [] : items.map((_, i) => i),
      ),
  );
  const [scrollTo, setScrollTo] = useState(focusIndex);
  useEffect(() => {
    if (scrollTo === undefined) return;
    listRef.current
      ?.querySelectorAll(':scope > .cfg-sortable-row')
      [scrollTo]?.scrollIntoView?.({ block: 'nearest' });
  }, [scrollTo, items.length]);

  function toggle(idx: number, open: boolean) {
    const next = new Set(expanded);
    if (open) next.add(idx);
    else next.delete(idx);
    setExpanded(next);
  }

  function move(from: number, to: number) {
    onChange(arrayMove(items, from, to));
    // The open state travels with the row, not with the position.
    const open = arrayMove(
      items.map((_, i) => expanded.has(i)),
      from,
      to,
    );
    setExpanded(new Set(open.flatMap((isOpen, i) => (isOpen ? [i] : []))));
  }

  function remove(idx: number) {
    onChange(items.filter((_, i) => i !== idx));
    setExpanded(new Set([...expanded].filter((i) => i !== idx).map((i) => (i > idx ? i - 1 : i))));
  }

  function add() {
    onChange([...items, newItem()]);
    setExpanded(new Set([...expanded, items.length]));
    setScrollTo(items.length);
  }

  return (
    <FieldDrawer title={path.length > 0 ? path.join(' › ') : title} onClose={onClose}>
      <div className="cfg-editor-actions cfg-list-drawer" ref={listRef}>
        <div className="cfg-editor-actions__title-row">
          <span className="cfg-field-group__label">{title}</span>
          <AddButton title={`Add ${noun}`} onClick={add}>
            + Add {noun}
          </AddButton>
        </div>
        {items.length === 0 && <div className="cfg-switch-empty">No {noun}s yet</div>}
        <SortableList ids={items.map((_, idx) => String(idx))} onMove={move}>
          {items.map((item, idx) => (
            <SortableRow key={idx} id={String(idx)}>
              <FieldGroup
                tier={3}
                kindLabel={<KindLabel>{itemTitle(item, idx)}</KindLabel>}
                summary={<PreviewText>{itemTitle(item, idx)}</PreviewText>}
                expanded={expanded.has(idx)}
                onExpandedChange={(open) => toggle(idx, open)}
                actions={
                  <button
                    type="button"
                    className="cfg-row-action-btn cfg-row-action-btn--stretch"
                    title={`Remove ${noun}`}
                    onClick={() => remove(idx)}
                  >
                    <ClearIcon />
                  </button>
                }
              >
                {renderItem(
                  item,
                  (patch) =>
                    onChange(items.map((row, i) => (i === idx ? { ...row, ...patch } : row))),
                  idx,
                )}
              </FieldGroup>
            </SortableRow>
          ))}
        </SortableList>
      </div>
    </FieldDrawer>
  );
}
