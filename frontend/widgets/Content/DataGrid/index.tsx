/* @jsxRuntime classic */
export const schema = {
  items: {
    type: 'item-list',
    label: 'Items',
    group: 'Data',
    description: 'The array shown, one row per element — a struct array from the PLC, say.',
  },
  columns: {
    type: 'item-list',
    format: 'columns',
    label: 'Columns',
    group: 'Data',
    description:
      'One entry per column: the member it shows, its title from any source, a width — Fill shares the free space, Fixed is a length such as 60px — and its alignment. Empty shows a column per member of the first row.',
  },
  sortMember: {
    type: 'string' as const,
    label: 'Sort by',
    group: 'Sort & filter',
    description:
      'The member the rows are sorted on at first. A click on a column header sorts on that column instead, and a second click reverses it.',
  },
  sortDirection: {
    type: 'String' as const,
    format: 'select' as const,
    label: 'Sort direction',
    group: 'Sort & filter',
    defaultValue: 'ascending',
    options: [
      { label: 'Ascending', value: 'ascending' },
      { label: 'Descending', value: 'descending' },
    ],
  },
  filterMember: {
    type: 'string' as const,
    label: 'Filter member',
    group: 'Sort & filter',
    description:
      'Shows only the rows whose value for this member contains Filter value, ignoring case.',
  },
  filterValue: {
    type: 'string' as const,
    label: 'Filter value',
    group: 'Sort & filter',
    description:
      'The text Filter member must contain — bind it to a search field. Empty shows every row.',
  },
  hideEmpty: {
    type: 'string' as const,
    label: 'Hide empty',
    group: 'Sort & filter',
    description:
      'Hides the rows whose value for this member is empty, such as the unused slots of a fixed PLC array.',
  },
  valueMember: {
    type: 'string' as const,
    label: 'Value member',
    group: 'Selection',
    description: "The member whose value is the Selected value. Empty uses the row's index.",
  },
  selectedValue: {
    type: ['string', 'integer'] as const,
    label: 'Selected value',
    group: 'Selection',
    description:
      'Selects the row whose Value member equals this and scrolls it into view; re-selects when a bound value changes.',
  },
  onSelect: {
    type: 'actions' as const,
    label: 'On Select',
    group: 'Actions',
    event: 'onSelect',
    repeatsOver: 'items',
    description: 'Runs when the operator picks a row. Repeat item reads that row.',
  },
};

export const exportedProperties: ExportedProperty[] = [
  { key: 'selectedItem', label: 'Selected Item', type: 'Struct' },
  { key: 'selectedIndex', label: 'Selected Index', type: 'integer' },
  // The Value member's own value, or the row's index: a number for an Integer tag.
  { key: 'selectedValue', label: 'Selected Value', type: ['string', 'integer', 'float'] },
];

export const displayName = 'Data Grid';
export const category = 'Content & controls';
export const description =
  'A table of an array, one row per element, with sorting, a filter and a selection. Only the rows in view are drawn, so a list of hundreds stays fast.';
export const icon = { type: 'builtin', name: 'table' } as const;

interface Row {
  item: unknown;
  /** Position of the element in the full items array. */
  index: number;
}

interface Column {
  member: string;
  /** The column as stored, whose title the header reads live. */
  source: Record<string, unknown>;
  track: string;
  align: string;
  /** A listed column with no member yet: its cells stay empty, not the whole row. */
  blank: boolean;
}

const ALIGN = /^(left|center|right)$/;
const LENGTH = /^\d+(\.\d+)?(px|rem|em|%)?$/;
/** Until the header is measured, and wherever it cannot be (jsdom). */
const ROW_FALLBACK = 40;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** One member of an element, by slash path; an empty member is the element itself. */
function cell(item: unknown, member: string): unknown {
  if (!member) return item;
  let cur: unknown = item;
  for (const seg of member.split('/')) {
    if (Array.isArray(cur)) cur = cur[Number(seg)];
    else if (isRecord(cur)) cur = cur[seg];
    else return undefined;
  }
  return cur;
}

function text(v: unknown): string {
  if (v === undefined || v === null) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** A cell as the operator reads it: a number with a decimal comma. */
function shown(v: unknown): string {
  return typeof v === 'number' ? formatNumber(v) : text(v);
}

/** Ordinal, like Optix OrderBy: numbers by value, everything else by code unit. */
function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const x = text(a);
  const y = text(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** A column width as a grid track: a length (a bare number is px) or a share of the rest. */
function track(width: unknown): string {
  const w =
    typeof width === 'number' ? String(width) : typeof width === 'string' ? width.trim() : '';
  if (!LENGTH.test(w)) return 'minmax(0, 1fr)';
  return /\d$/.test(w) ? `${w}px` : w;
}

/** A header's title from any source, a `$var` one read live; the member when unset. */
function ColumnTitle({ column, member }: { column: Record<string, unknown>; member: string }) {
  return <>{usePropString(column, 'title', member)}</>;
}

export default function DataGrid({ id, properties, layout }: HmiWidgetProps) {
  const evalCtx = useEvalContext();
  const scope = useHmiScope();
  const { items } = useItemListProp(properties, 'items');
  const { items: columnList } = useItemListProp(properties, 'columns');
  const valueMember = usePropString(properties, 'valueMember', '');
  const filterMember = usePropString(properties, 'filterMember', '');
  // As stored, not usePropString's decimal comma: both are matched against cell text.
  const filterValue = text(usePropVar(properties, 'filterValue'));
  const hideEmpty = usePropString(properties, 'hideEmpty', '');
  const sortMember = usePropString(properties, 'sortMember', '');
  const sortDesc = usePropString(properties, 'sortDirection', 'ascending') === 'descending';
  const propSelected = text(usePropVar(properties, 'selectedValue'));

  const [sort, setSort] = useState({ member: sortMember, desc: sortDesc });
  useEffect(() => setSort({ member: sortMember, desc: sortDesc }), [sortMember, sortDesc]);
  const [selected, setSelected] = useState(propSelected);
  useEffect(() => setSelected(propSelected), [propSelected]);

  const headRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [rowHeight, setRowHeight] = useState(ROW_FALLBACK);
  // Every row is as tall as the header: both take --hmi-datagrid-row-height.
  useEffect(() => {
    const h = headRef.current?.offsetHeight;
    if (h) setRowHeight(h);
  }, []);

  const columns = useMemo((): Column[] => {
    const listed = columnList.filter(isRecord);
    const first = items[0];
    const source = listed.length
      ? listed
      : isRecord(first)
        ? Object.keys(first).map((member) => ({ member }))
        : [{ member: '' }];
    return source.map((c: Record<string, unknown>) => {
      const member = typeof c.member === 'string' ? c.member : '';
      return {
        member,
        source: c,
        track: track(c.width),
        blank: listed.length > 0 && !member,
        align: typeof c.align === 'string' && ALIGN.test(c.align) ? c.align : 'left',
      };
    });
  }, [columnList, items]);

  const rows = useMemo((): Row[] => {
    const needle = filterValue.toLowerCase();
    const list = items
      .map((item, index) => ({ item, index }))
      .filter(
        ({ item }) =>
          (!hideEmpty || text(cell(item, hideEmpty)) !== '') &&
          (!filterMember ||
            !needle ||
            text(cell(item, filterMember)).toLowerCase().includes(needle)),
      );
    if (sort.member) {
      const sign = sort.desc ? -1 : 1;
      list.sort((a, b) => sign * compare(cell(a.item, sort.member), cell(b.item, sort.member)));
    }
    return list;
  }, [items, filterMember, filterValue, hideEmpty, sort]);

  const valueOf = (row: Row) => (valueMember ? cell(row.item, valueMember) : row.index);
  const keyOf = (row: Row) => text(valueOf(row));
  const selectedPos = selected === '' ? -1 : rows.findIndex((row) => keyOf(row) === selected);
  const selectedIndex =
    selected === '' ? -1 : items.findIndex((item, index) => keyOf({ item, index }) === selected);

  const publishIndex = usePublishWidgetProp(id, 'selectedIndex', selectedIndex);
  const publishValue = usePublishWidgetProp(
    id,
    'selectedValue',
    selectedIndex >= 0 ? valueOf({ item: items[selectedIndex], index: selectedIndex }) : '',
  );
  const publishItem = usePublishWidgetProp(
    id,
    'selectedItem',
    selectedIndex >= 0 ? items[selectedIndex] : null,
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => bodyRef.current,
    estimateSize: () => rowHeight,
    overscan: 8,
  });
  useEffect(() => virtualizer.measure(), [virtualizer, rowHeight]);

  // A bound value scrolls its row into view once — when it changes, or when
  // its row first arrives — not on every later update of the items.
  const pendingScroll = useRef('');
  useEffect(() => {
    pendingScroll.current = propSelected;
  }, [propSelected]);
  useEffect(() => {
    if (!pendingScroll.current || pendingScroll.current !== selected || selectedPos < 0) return;
    pendingScroll.current = '';
    virtualizer.scrollToIndex(selectedPos, { align: 'auto' });
  }, [virtualizer, propSelected, selected, selectedPos]);

  function choose(row: Row) {
    const key = keyOf(row);
    if (key === selected) return;
    setSelected(key);
    publishIndex(row.index);
    publishValue(valueOf(row));
    publishItem(row.item);
    const actions = (properties?.onSelect as ActionsConfig | undefined)?.onSelect;
    executeWidgetActions(actions, {
      scope,
      evalCtx: {
        ...evalCtx,
        repeatIndex: row.index,
        resolveRepeatItem: (payload: unknown) => {
          const p = isRecord(payload) ? payload : {};
          if (p.field === 'index') return row.index;
          const v = cell(row.item, typeof p.member === 'string' ? p.member.trim() : '');
          return v === undefined || v === null
            ? null
            : typeof v === 'object'
              ? JSON.stringify(v)
              : v;
        },
      },
    });
  }

  function sortOn(member: string) {
    setSort((s) => ({ member, desc: s.member === member ? !s.desc : false }));
  }

  function handleKeyDown(event: { key: string; preventDefault(): void }) {
    if (rows.length === 0) return;
    const last = rows.length - 1;
    const next =
      event.key === 'ArrowDown'
        ? Math.min(last, selectedPos + 1)
        : event.key === 'ArrowUp'
          ? Math.max(0, selectedPos - 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    choose(rows[next]);
    virtualizer.scrollToIndex(next, { align: 'auto' });
  }

  const gridStyle = {
    ...selfLayoutStyle(layout),
    '--hmi-datagrid-columns': columns.map((c) => c.track).join(' '),
  };

  return (
    <div
      className="hmi-component hmi-datagrid"
      style={gridStyle}
      role="grid"
      aria-rowcount={rows.length + 1}
    >
      <div ref={headRef} className="hmi-datagrid__head" role="row" aria-rowindex={1}>
        {columns.map((c, i) => {
          const sorted = sort.member !== '' && sort.member === c.member;
          return (
            <div
              key={`${i}:${c.member}`}
              role="columnheader"
              className="hmi-datagrid__th"
              data-align={c.align}
              aria-sort={sorted ? (sort.desc ? 'descending' : 'ascending') : 'none'}
            >
              <button type="button" className="hmi-datagrid__sort" onClick={() => sortOn(c.member)}>
                <ColumnTitle column={c.source} member={c.member} />
                {sorted && (
                  <span className="hmi-datagrid__arrow" aria-hidden="true">
                    {sort.desc ? '▼' : '▲'}
                  </span>
                )}
              </button>
            </div>
          );
        })}
      </div>
      <div
        ref={bodyRef}
        className="hmi-datagrid__body"
        role="rowgroup"
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        <div
          className="hmi-datagrid__rows"
          style={{ '--hmi-datagrid-total': `${virtualizer.getTotalSize()}px` }}
        >
          {virtualizer.getVirtualItems().map((v) => {
            const row = rows[v.index];
            return (
              <div
                key={`${row.index}`}
                role="row"
                aria-rowindex={v.index + 2}
                aria-selected={v.index === selectedPos}
                className="hmi-datagrid__row"
                style={{ '--hmi-datagrid-row-y': `${v.start}px` }}
                onClick={() => choose(row)}
              >
                {columns.map((c, i) => (
                  <div
                    key={`${i}:${c.member}`}
                    role="gridcell"
                    className="hmi-datagrid__cell"
                    data-align={c.align}
                  >
                    {c.blank ? '' : shown(cell(row.item, c.member))}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
