import { useEffect, useState } from 'react';
import { getStaticString } from '@config/components/editor/propertyValueUtils';
import { FieldActions } from '@config/components/ui/FieldGroup';
import Select from '@config/components/ui/Select';
import { hintWidthVar, NO_VALUE_LABEL } from './hintStyle';

const CYCLE_UNITS = ['px', '%', 'rem', 'em', 'vh', 'vw', 'auto'] as const;

/** Units that stand alone, with no magnitude to attach — they commit as-is. */
const KEYWORD_UNITS = ['auto'];

/** Next unit in the cycle, wrapping around. Empty/unknown starts at `px`. */
function nextUnit(unit: string, units: readonly string[]): string {
  const i = units.indexOf(unit);
  return units[(i + 1) % units.length];
}

/**
 * Parse a stored length string ("16px", "auto", "0") into its number/unit parts
 * for the split control.
 *
 * The unit is optional: `"0"` is valid CSS and reaches the style object
 * verbatim, so a magnitude without one has to survive the round trip — matching
 * only `<number><unit>` made those fields render as an empty box beside an
 * active revert button, which reads as a broken row. An unrecognised unit is
 * captured rather than dropped, so editing the magnitude never silently
 * rewrites someone's `ch`/`ex`/`vmin` value.
 */
function parseLength(raw: string, units: readonly string[]): { num: string; unit: string } {
  const text = raw.trim();
  if (text === '') return { num: '', unit: '' };
  const m = text.match(/^(-?\d*\.?\d+)\s*([a-z%]*)$/i);
  if (m) return { num: m[1], unit: m[2] };
  return units.includes(text) ? { num: '', unit: text } : { num: '', unit: '' };
}

export interface LengthFieldProps {
  value: unknown;
  onChange: (v: unknown) => void;
  /**
   * How the unit is chosen. `cycle` (the default) is the property panels' single
   * button that steps through the unit list; `select` is a dropdown, for
   * surfaces that offer a "no unit" entry and need to show which units exist.
   */
  unitMode?: 'cycle' | 'select';
  /** Units offered, in cycle order. Defaults to the CSS length set. */
  units?: readonly string[];
  /** What an emptied magnitude commits as — `undefined` unsets the property,
   *  `''` writes an empty string for surfaces whose storage has no unset. */
  emptyCommit?: '' | undefined;
  /** Number-input step. Defaults to `any` while cycling, and to a per-unit step
   *  (1 for px/%, 0.05 for the rem/em scale) in dropdown mode. */
  step?: number | 'any';
  /** Placeholder for the magnitude input. `defaultText` supplies one derived
   *  from the resolved fallback when this is omitted. */
  placeholder?: string;
  /** When the field is unset and falls back to a themed/plain default, there is
   *  no literal magnitude to attach a unit to — the toggle greys out. */
  disabledUnit?: boolean;
  /** Resolved fallback length ("auto", "8px") shown as a grey placeholder while
   *  unset, with its unit mirrored onto the greyed-out unit toggle. */
  defaultText?: string;
}

/**
 * `format:'length'` static editor — number input + unit control over the
 * existing string storage (recombines to e.g. "16px" on change, no schema
 * change). A keyword unit like `auto` has no magnitude, so the number input
 * disables for it.
 */
export function LengthField({
  value,
  onChange,
  unitMode = 'cycle',
  units = CYCLE_UNITS,
  emptyCommit = undefined,
  step,
  placeholder,
  disabledUnit = false,
  defaultText,
}: LengthFieldProps) {
  const parsed = parseLength(getStaticString(value), units);
  // A unit picked before any magnitude is typed (or picked while the stored
  // value is 'auto', which has no magnitude to attach a unit to) — held
  // locally, overriding the parsed unit, so cycling doesn't wipe the field.
  // Reset whenever a new committed `value` arrives from outside.
  const [pendingUnit, setPendingUnit] = useState<string | null>(null);

  useEffect(() => {
    setPendingUnit(null);
  }, [value]);

  function commit(num: string, unit: string) {
    if (KEYWORD_UNITS.includes(unit)) {
      onChange(unit);
      return;
    }
    if (num === '') {
      onChange(emptyCommit);
      return;
    }
    onChange(unit ? `${num}${unit}` : num);
  }

  // A fallback like "8px" splits across the two controls (grey "8" placeholder +
  // "px" on the toggle); one with no magnitude ("auto", "none", "0") has nothing
  // to split, so it shows whole in the placeholder. `num` can legitimately be
  // "0" — check for the empty string, not falsiness, or a zero fallback would
  // wrongly show the whole "0px" in the placeholder instead of splitting it.
  const fallback = defaultText ? parseLength(defaultText, units) : null;
  // A stored magnitude with no unit shows the first unit rather than the
  // fallback's: it is the unit the value commits back as, and borrowing the
  // default's would claim a `rem` the stored value never had. In dropdown mode
  // the empty unit is a real choice, so it stays empty.
  const cycling = unitMode === 'cycle';
  const unit = cycling
    ? (pendingUnit ?? (parsed.unit || (parsed.num !== '' ? units[0] : fallback?.unit) || units[0]))
    : (pendingUnit ?? parsed.unit);
  // `defaultText` is `''` when the row has a default but it resolved to nothing
  // (a token the theme doesn't define). Fall back to the same 'not set' label
  // the other formats use (`defaultAwareInput` in renderSchemaField) rather than
  // leaving the placeholder empty: without one the input keeps its full
  // intrinsic width and shoves the `· default(…)` suffix onto the row's action
  // buttons.
  const resolved = placeholder ?? (fallback && fallback.num !== '' ? fallback.num : defaultText);
  const hint = resolved || (defaultText === undefined ? undefined : NO_VALUE_LABEL);
  const noValue = hint === NO_VALUE_LABEL;
  const numberStep = step ?? (cycling ? 'any' : unit === 'px' || unit === '%' ? 1 : 0.05);
  // A keyword unit carries no magnitude, so a typed number cannot attach to it —
  // it reaches the toggle only as an unset field's greyed-out fallback ('auto' on
  // Basis/Width/Height). Committing it verbatim would drop the digits and leave
  // the row stuck on the keyword, so a magnitude commits under a real unit.
  const magnitudeUnit = KEYWORD_UNITS.includes(unit)
    ? (units.find((u) => !KEYWORD_UNITS.includes(u)) ?? '')
    : unit || units[0];

  function cycleUnit() {
    const next = nextUnit(unit, units);
    if (KEYWORD_UNITS.includes(next) || parsed.num !== '') {
      commit(parsed.num, next);
      setPendingUnit(null);
    } else {
      setPendingUnit(next);
    }
  }

  // An unrecognised stored unit is offered alongside the known ones so picking
  // another unit is possible without the current one vanishing from the list.
  const options = unit && !units.includes(unit) ? [unit, ...units] : units;

  return (
    <div className={cycling ? 'cfg-length-field' : 'cfg-theme-length'}>
      <input
        className={
          cycling
            ? `cfg-prop-input${hint ? ' cfg-prop-input--hint' : ''}${
                noValue ? ' cfg-prop-input--no-value' : ''
              }`
            : 'cfg-prop-input cfg-theme-length__num'
        }
        type="number"
        step={numberStep}
        value={parsed.num}
        placeholder={hint}
        style={cycling && hint ? hintWidthVar(hint) : undefined}
        disabled={KEYWORD_UNITS.includes(pendingUnit ?? parsed.unit)}
        onChange={(e) => commit(e.target.value, magnitudeUnit)}
      />
      {cycling ? (
        <FieldActions>
          <button
            type="button"
            className={`cfg-row-action-btn cfg-row-action-btn--stretch cfg-row-action-btn--unit${
              disabledUnit ? ' is-disabled' : ''
            }`}
            title={disabledUnit ? 'Set a value to choose a unit' : 'Cycle unit'}
            disabled={disabledUnit}
            onClick={cycleUnit}
          >
            {unit}
          </button>
        </FieldActions>
      ) : (
        <Select
          value={unit}
          onChange={(v) => commit(parsed.num || '0', v)}
          className="cfg-select--auto"
        >
          <option value="">—</option>
          {options.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </Select>
      )}
    </div>
  );
}
