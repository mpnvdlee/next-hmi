import Select from '@config/components/ui/Select';
import TranslationInput from '@config/components/editor/TranslationInput';
import RowList from './RowList';

/** One Data Grid column as stored: the grid reads each field leniently, so a
 *  hand-written width may be a bare number (px). */
export interface ColumnEntry {
  member?: string;
  title?: string | { $loc: string };
  width?: string | number;
  align?: string;
}

interface Props {
  value: ColumnEntry[];
  onChange: (v: ColumnEntry[]) => void;
}

/** The static value of a `format: 'columns'` item list: one row per column —
 *  member, title (plain or a translation), width and alignment. */
export default function ColumnsInput({ value, onChange }: Props) {
  return (
    <RowList
      items={value}
      onChange={onChange}
      newItem={() => ({ member: '' })}
      cells={(column, update) => (
        <>
          <input
            type="text"
            className="cfg-items-input__field cfg-prop-input"
            placeholder="Member"
            aria-label="Member"
            value={column.member ?? ''}
            onChange={(e) => update({ member: e.target.value })}
          />
          <div className="cfg-items-input__field">
            <TranslationInput
              value={column.title ?? ''}
              onChange={(next) => update({ title: next as ColumnEntry['title'] })}
            />
          </div>
          <input
            type="text"
            className="cfg-items-input__field cfg-prop-input"
            placeholder="Width"
            aria-label="Width"
            title='A length such as 60px, or "fill" to share the free space'
            value={column.width ?? ''}
            onChange={(e) => update({ width: e.target.value || undefined })}
          />
          <Select
            className="cfg-items-input__field"
            title="Align"
            value={column.align ?? 'left'}
            onChange={(align) => update({ align })}
          >
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </Select>
        </>
      )}
    />
  );
}
