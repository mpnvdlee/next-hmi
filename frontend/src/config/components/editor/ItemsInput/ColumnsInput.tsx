import Select from '@config/components/ui/Select';
import PropRow from '@config/components/ui/PropRow';
import SchemaFieldRow from '@config/components/ui/SchemaFieldRow';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { renderSchemaField } from '@config/utils/renderSchemaField';
import { LengthField } from '@config/utils/LengthField';
import { isLocSource } from '@shared/types/propertyValueGuards';
import type { SchemaField } from '@shared/types/widgetSchema';
import { RepeatItemsScope } from '../PropertySourceEditor/RepeatEditorScopeProvider';
import { useRepeatEditorScope } from '../PropertySourceEditor/repeatScopeContext';
import { slotFilter } from '../PropertySourceEditor/editors/utils';
import PanelList from './PanelList';

/** One Data Grid column as stored: the grid reads each field leniently, so a
 *  hand-written width may be a bare number (px) and the title any source. */
export interface ColumnEntry {
  member?: string;
  title?: unknown;
  width?: string | number;
  align?: string;
}

interface Props {
  value: ColumnEntry[];
  onChange: (v: ColumnEntry[]) => void;
  /** The widget's `items` value, whose element members the columns pick from. */
  rows?: unknown;
}

const TITLE_SCHEMA: SchemaField = { type: 'String', label: 'Title' };
const ALIGN_SCHEMA: SchemaField = {
  type: 'String',
  label: 'Align',
  format: 'select',
  display: 'button-text',
  defaultValue: 'left',
  options: [
    { label: 'Left', value: 'left' },
    { label: 'Center', value: 'center' },
    { label: 'Right', value: 'right' },
  ],
};
const WIDTH_SCHEMA: SchemaField = {
  type: 'String',
  label: 'Width',
  format: 'select',
  display: 'button-text',
  options: [
    { label: 'Fill', value: 'fill' },
    { label: 'Fixed', value: 'fixed' },
  ],
};
const PX_ONLY = ['px'];

/** What the grid makes of a width: a length (a bare number is px) is fixed,
 *  anything else shares the free space. */
function isFixed(width: ColumnEntry['width']): boolean {
  return typeof width === 'number' || /^\d/.test(String(width ?? '').trim());
}

/** A column as its line and its drawer row name it: a plain or translated
 *  title, else its member; a new one, with neither yet, a muted placeholder. */
function ColumnName({ column }: { column: ColumnEntry }) {
  const name =
    typeof column.title === 'string' && column.title
      ? column.title
      : isLocSource(column.title) && column.title.$loc
        ? column.title.$loc
        : column.member;
  return name ? <>{name}</> : <span className="cfg-list-drawer__meta">New column</span>;
}

/** A column's member: picked from the elements' members when they are known, else typed. */
function MemberField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const scope = useRepeatEditorScope();
  const members = scope?.memberInfo ? Object.keys(scope.memberInfo) : (scope?.members ?? []);
  if (members.length === 0) {
    return (
      <input
        type="text"
        className="cfg-prop-input"
        placeholder="Member"
        aria-label="Member"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <Select value={value} onChange={onChange}>
      {!members.includes(value) && <option value={value}>{value || '—'}</option>}
      {members.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </Select>
  );
}

/** The static value of a `format: 'columns'` item list: one line per column
 *  in the panel, as an option list has (see `PanelList`); its drawer row holds
 *  the member, title (any source), width and alignment. */
export default function ColumnsInput({ value, onChange, rows }: Props) {
  const openBindingPicker = useEditorDomainStore((s) => s.openBindingPicker);

  return (
    <PanelList
      title="Columns"
      noun="column"
      openCollapsed
      items={value}
      onChange={onChange}
      newItem={() => ({ member: '' })}
      empty="A column per member"
      line={(column) => (
        <span className="cfg-panel-list__text">
          <ColumnName column={column} />
        </span>
      )}
      itemTitle={(column, idx) => (
        <>
          <span className="cfg-list-drawer__meta">{idx + 1}</span> <ColumnName column={column} />
          <span className="cfg-list-drawer__meta">
            {' · '}
            {isFixed(column.width) ? String(column.width) : 'Fill'} · {column.align ?? 'left'}
          </span>
        </>
      )}
      renderItem={(column, update) => (
        <>
          <PropRow label="Member">
            <RepeatItemsScope items={rows}>
              <MemberField value={column.member ?? ''} onChange={(member) => update({ member })} />
            </RepeatItemsScope>
          </PropRow>
          <SchemaFieldRow
            schema={TITLE_SCHEMA}
            value={column.title}
            onChange={(title) => update({ title })}
            onOpenPicker={(onPick, currentBinding, slot, extras) =>
              openBindingPicker('__columns__', 'title', {
                ...extras,
                onPick,
                currentBinding,
                filter: slotFilter({ label: 'Title', type: 'String' }, slot),
              })
            }
          />
          <PropRow label="Width">
            {renderSchemaField(WIDTH_SCHEMA, isFixed(column.width) ? 'fixed' : 'fill', (mode) =>
              update({
                width:
                  mode !== 'fixed' ? undefined : isFixed(column.width) ? column.width : '100px',
              }),
            )}
          </PropRow>
          {isFixed(column.width) && (
            <PropRow label="Fixed width">
              <LengthField
                value={String(column.width)}
                units={PX_ONLY}
                // An emptied stepper keeps the last width: empty would read as Fill.
                onChange={(width) => width && update({ width: width as string })}
              />
            </PropRow>
          )}
          <PropRow label="Align">
            {renderSchemaField(ALIGN_SCHEMA, column.align, (align) =>
              update({ align: (align as string | undefined) ?? undefined }),
            )}
          </PropRow>
        </>
      )}
    />
  );
}
