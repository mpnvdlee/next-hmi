import './style.css';
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { BindingPickMetadata } from '@config/store/domains/editorDomainStore';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { useHistorianConfigStore } from '@config/store/historianConfigStore';
import { PanelScopeContext } from '@config/store/panelExpansionStore';
import type { VariableBinding } from '@shared/types/config';
import { bindingParts } from '@shared/types/config';
import { getStaticString, unwrapStatic } from '@config/components/editor/propertyValueUtils';
import AddButton from '@config/components/ui/AddButton';
import FieldGroup from '@config/components/ui/FieldGroup';
import PropertySourceBadge from '@config/components/editor/PropertySourceSelector/PropertySourceBadge';
import Select from '@config/components/ui/Select';
import { ChevronDownIcon, ClearIcon, EditIcon } from '@config/components/ui/actionIcons';

/** A chart plots numbers, and the historian stores every sample as a REAL — so
 *  both halves of the picker offer the same coercible set. */
const PLOTTABLE_TYPES = ['Integer', 'Float', 'Boolean'];

/** Split the stored list. The separator is a comma; the widget trims each entry,
 *  so a hand-written value with spaces survives the round-trip. */
function splitVariables(value: unknown): string[] {
  // The field is not source-capable, so a sourced object here can only be legacy
  // data — it has no rows to show, and `String(…)` would invent one.
  const inner = unwrapStatic(value);
  if (inner !== null && typeof inner === 'object') return [];
  return getStaticString(inner)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

interface Props {
  value: unknown;
  onChange: (v: unknown) => void;
  /** Field label — heads the list and titles the binding picker. */
  label: string;
  description?: ReactNode;
  /** Offer only the variables the historian records. Recorded mode can plot
   *  nothing else, so each row picks from that list; live mode buffers values
   *  straight off the connection and takes the whole variable tree. */
  recordedOnly: boolean;
}

/**
 * The editor for a `format: 'variables'` field: one property row per line on
 * the chart, stored as the comma-separated string the widget reads.
 *
 * Same shape as an action list — the add control sits behind the title, the
 * group itself gets no box, and every entry is its own row. Which picker a row
 * carries follows the chart's mode, so it can only ever name a variable the
 * chart could actually draw.
 *
 * Order is part of the value (`seriesColors` is positional), hence the reorder
 * pair an action row has no use for.
 */
export default function VariableListInput({
  value,
  onChange,
  label,
  description,
  recordedOnly,
}: Props) {
  const openBindingPicker = useEditorDomainStore((s) => s.openBindingPicker);
  const config = useHistorianConfigStore((s) => s.config);
  const load = useHistorianConfigStore((s) => s.load);
  const widgetId = useContext(PanelScopeContext);

  // The Historian area loads this for its own screen; a recorded-mode chart is
  // the only other thing that needs the tracked list, so it fetches on demand
  // rather than on every panel mount.
  useEffect(() => {
    if (recordedOnly && !config) load();
  }, [recordedOnly, config, load]);

  // A row being filled in has no key yet, and an empty entry cannot survive a
  // comma-joined string — so the rows are held here and the property is written
  // from the ones that name something.
  const [rows, setRows] = useState<string[]>(() => splitVariables(value));
  const committed = splitVariables(value).join(', ');
  const adopted = useRef(committed);
  const scope = useRef(widgetId);
  useEffect(() => {
    // Re-read the property only when something *else* changed it — an undo, a
    // paste, another widget selected. Re-reading our own write would drop the
    // blank row the author is in the middle of filling.
    if (committed === adopted.current && widgetId === scope.current) return;
    adopted.current = committed;
    scope.current = widgetId;
    setRows(committed ? committed.split(', ') : []);
  }, [committed, widgetId]);

  // Sorted once per historian config, not on every panel keystroke — a
  // property write replaces the widget objects up the page path, so this
  // component re-renders on each one.
  const tracked = useMemo(
    () => (config ? Object.keys(config.variables).sort() : null),
    [config],
  );

  function commit(next: string[]) {
    setRows(next);
    const joined = next.filter(Boolean).join(', ');
    adopted.current = joined;
    onChange(joined || undefined);
  }

  function setAt(base: string[], idx: number, key: string) {
    commit(base.map((row, i) => (i === idx ? key : row)));
  }

  function removeAt(idx: number) {
    commit(rows.filter((_, i) => i !== idx));
  }

  function move(idx: number, delta: number) {
    const target = idx + delta;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    [next[idx], next[target]] = [next[target], next[idx]];
    commit(next);
  }

  // `base` is the row list the picker was opened against — the one `addRow`
  // just built, which is not yet the `rows` this render closed over.
  function pickInto(idx: number, base: string[] = rows) {
    openBindingPicker('', 'trendVariable', {
      onPick: (binding: VariableBinding, metadata?: BindingPickMetadata) => {
        const { datasource, location } = bindingParts(binding);
        if (!datasource || !location) return;
        // The flat `datasource:path` composite the historian and the chart both
        // key on, with an array index baked into the path.
        setAt(
          base,
          idx,
          metadata?.index !== undefined
            ? `${datasource}:${location}[${metadata.index}]`
            : `${datasource}:${location}`,
        );
      },
      filter: { label, type: PLOTTABLE_TYPES },
    });
  }

  function addRow() {
    const next = [...rows, ''];
    setRows(next);
    // The new row opens on its picker, the way a new `$switch` case opens on its
    // editors. A recorded row's dropdown is already in reach.
    if (!recordedOnly) pickInto(next.length - 1, next);
  }

  /** Tracked variables still free for this row, plus whatever it names today —
   *  an option the list has dropped would otherwise blank the control. */
  function optionsFor(idx: number): { key: string; label: string }[] {
    const taken = new Set(rows.filter((_, i) => i !== idx));
    const free = (tracked ?? []).filter((key) => !taken.has(key));
    const current = rows[idx];
    if (current && !free.includes(current)) {
      // Until the historian config is in hand — or if `load()` failed, which
      // leaves it null for good — nothing is known about what is recorded, so
      // the row names itself without a claim it cannot support.
      const flagged = tracked === null ? current : `${current} (not recorded)`;
      return [{ key: current, label: flagged }, ...free.map(asOption)];
    }
    return free.map(asOption);
  }

  return (
    // No box around the group: every entry is already its own row, exactly as an
    // action list renders (see SchemaFieldRow's `actions` branch).
    <div className="cfg-editor-actions">
      <div className="cfg-editor-actions__title-row">
        <span className="cfg-field-group__label">{label}</span>
        <AddButton title="Add variable" onClick={addRow} />
      </div>
      {description && <p className="cfg-field-group__desc">{description}</p>}

      {rows.length === 0 && <div className="cfg-prop-hint">No variables yet</div>}
      {rows.map((key, idx) => (
        // No label: a line's only identity is the variable it names, the same
        // way an action row is titled by its own kind rather than its position.
        <FieldGroup
          key={idx}
          tier={recordedOnly ? 2 : 1}
          badge={<PropertySourceBadge source="static" variant="cap" />}
          actions={
            <>
              {/* Recorded rows carry the Select's own chevron; a live row's box
                  needs the `✎` every other binding field opens its picker with. */}
              {!recordedOnly && (
                <button
                  type="button"
                  className="cfg-row-action-btn cfg-row-action-btn--stretch"
                  title="Select variable"
                  onClick={() => pickInto(idx)}
                >
                  <EditIcon />
                </button>
              )}
              <button
                type="button"
                className="cfg-row-action-btn cfg-row-action-btn--stretch"
                title="Move up"
                disabled={idx === 0}
                onClick={() => move(idx, -1)}
              >
                <ChevronDownIcon className="cfg-var-list__up" />
              </button>
              <button
                type="button"
                className="cfg-row-action-btn cfg-row-action-btn--stretch"
                title="Move down"
                disabled={idx >= rows.length - 1}
                onClick={() => move(idx, 1)}
              >
                <ChevronDownIcon />
              </button>
              <button
                type="button"
                className="cfg-row-action-btn cfg-row-action-btn--stretch"
                title="Remove variable"
                onClick={() => removeAt(idx)}
              >
                <ClearIcon />
              </button>
            </>
          }
        >
          {recordedOnly ? (
            <Select
              popupClassName="cfg-var-list__popup"
              value={key}
              placeholder="Select variable…"
              onChange={(next) => setAt(rows, idx, next)}
            >
              {optionsFor(idx).map((opt) => (
                <option key={opt.key} value={opt.key}>
                  {opt.label}
                </option>
              ))}
            </Select>
          ) : (
            // The `.cfg-var-field` box a bound path always renders in, made the
            // click target itself. `PickerField` cannot serve here: its trailing
            // buttons portal into the enclosing row's action slot, landing beside
            // this row's own.
            <button
              type="button"
              className="cfg-var-field cfg-var-list__pick"
              title={key || 'Select variable'}
              onClick={() => pickInto(idx)}
            >
              <span
                className={`cfg-var-field__text cfg-var-field__path${
                  key ? '' : ' cfg-var-field__text--empty'
                }`}
              >
                <bdi>{key || 'Select variable…'}</bdi>
              </span>
            </button>
          )}
        </FieldGroup>
      ))}

      {recordedOnly && tracked && tracked.length === 0 && (
        <div className="cfg-prop-hint">
          No variables are being recorded — add them in the Historian area first.
        </div>
      )}
    </div>
  );
}

const asOption = (key: string) => ({ key, label: key });
