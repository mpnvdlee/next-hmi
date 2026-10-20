/* @jsxRuntime classic */
export const schema = {
  label: { type: 'string' as const, label: 'Label', group: 'Content' },
  unit: { type: 'string' as const, label: 'Unit', group: 'Content' },
  variable: { type: ['float', 'integer'] as const, label: 'Value', group: 'Data' },
  step: { type: 'float' as const, label: 'Step', group: 'Data', step: 0.1, defaultValue: 1 },
  min: { type: 'float' as const, label: 'Min value', group: 'Data' },
  max: { type: 'float' as const, label: 'Max value', group: 'Data' },
  decimals: {
    type: 'integer' as const,
    label: 'Decimal places',
    group: 'Appearance',
    min: 0,
    max: 6,
    step: 1,
    defaultValue: 0,
  },
  showRangeOnNumpad: {
    type: 'boolean' as const,
    label: 'Show range on numpad',
    group: 'Appearance',
    defaultValue: true,
  },
};

export const displayName = 'Numeric Stepper';
export const description = 'Increment / decrement a numeric variable with + / − buttons.';
export const category = 'Inputs';
export const icon = { type: 'builtin', name: 'arrows-left-right' } as const;

// The schema's min/max on `decimals` are editor hints, and the property is
// expression-capable: a binding can deliver anything, and toFixed throws a
// RangeError outside 0–100.
function formatValue(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return '---';
  return value.toFixed(Math.min(6, Math.max(0, Math.trunc(decimals))));
}

function formatInteger(value: bigint, decimals: number): string {
  const places = Math.min(6, Math.max(0, Math.trunc(decimals)));
  return places > 0 ? `${value}.${'0'.repeat(places)}` : value.toString();
}

/** A value's exact integer, when it is written as integer digits. */
function integerOf(value: unknown): bigint | null {
  const digits = typeof value === 'string' ? value.trim() : '';
  return /^[+-]?\d+$/.test(digits) ? BigInt(digits) : null;
}

function exactBound(raw: unknown, bound: number): number | bigint {
  const exact = integerOf(raw);
  return exact !== null && !Number.isSafeInteger(bound) ? exact : bound;
}

function isFiniteBound(bound: number | bigint): boolean {
  return typeof bound === 'bigint' || Number.isFinite(bound);
}

/** The write form: a number while it is exact, its digits beyond that. */
function writable(value: number | bigint): number | string {
  if (typeof value === 'number') return value;
  return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
}

export default function NumericStepper({ properties, layout }: HmiWidgetProps) {
  const evalCtx = useEvalContext();
  const meta = useVariableMeta(bindingKey(getPropBinding(properties, 'variable')));
  const rawValue = usePropVar(properties, 'variable');
  const fValue = readNumberValue(rawValue);
  // An integer beyond ±(2**53 − 1) arrives as its decimal string and reads as
  // the nearest double, so every comparison, step and display uses its exact
  // digits instead; the write path takes them as-is.
  const exactValue = fValue != null && !Number.isSafeInteger(fValue) ? integerOf(rawValue) : null;
  const writeVariable = useWriteVariable(properties, 'variable');

  const label = getPropString(properties, 'label', '', evalCtx);
  const unit = getPropString(properties, 'unit', '', evalCtx);
  const step = usePropNumber(properties, 'step', 1);
  const decimals = usePropNumber(properties, 'decimals', 0);
  const showRangeOnNumpad = getPropBoolean(properties, 'showRangeOnNumpad', true, evalCtx);

  // Widget-configured min/max win when set; otherwise fall back to the
  // range configured on the bound variable itself. A bound written as integer
  // digits keeps them, for a counter beyond the double's exact range.
  const widgetMin = exactBound(
    usePropVar(properties, 'min'),
    usePropNumber(properties, 'min', Number.NEGATIVE_INFINITY),
  );
  const widgetMax = exactBound(
    usePropVar(properties, 'max'),
    usePropNumber(properties, 'max', Number.POSITIVE_INFINITY),
  );
  const min = isFiniteBound(widgetMin) ? widgetMin : (meta?.min ?? Number.NEGATIVE_INFINITY);
  const max = isFiniteBound(widgetMax) ? widgetMax : (meta?.max ?? Number.POSITIVE_INFINITY);

  // localValue only feeds the numpad while editing; openNumpad seeds it at
  // edit-start, so no effect is needed to sync it from fValue.
  const [localValue, setLocalValue] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const displayValue = isEditing
    ? localValue
    : exactValue !== null
      ? formatInteger(exactValue, decimals)
      : fValue != null
        ? formatValue(fValue, decimals)
        : '---';
  // Only a `$var` binding can be written back: with any other source the value
  // still renders but the writer no-ops, so the controls must read as disabled
  // rather than swallow the press.
  const canWrite = writeVariable.canWrite;
  const isIdle = !canWrite || fValue == null;
  const exactStep = exactValue !== null && Number.isInteger(step) ? BigInt(step) : null;
  const canDecrement =
    canWrite &&
    fValue != null &&
    (exactStep !== null ? exactValue! - exactStep >= min : fValue - step >= min);
  const canIncrement =
    canWrite &&
    fValue != null &&
    (exactStep !== null ? exactValue! + exactStep <= max : fValue + step <= max);
  const current = exactValue ?? fValue;
  const isOutOfRange =
    current != null &&
    ((isFiniteBound(min) && current < min) || (isFiniteBound(max) && current > max));

  function openNumpad() {
    if (isIdle || isEditing) return;
    setLocalValue(exactValue !== null ? exactValue.toString() : String(fValue));
    setIsEditing(true);
  }

  // The *widget's* min/max is an authored design-time limit, so the widget
  // applies it itself — `useWriteVariable` only enforces the range configured
  // on the variable. Clamping to `widgetMin`/`widgetMax` rather than to the
  // merged `min`/`max` keeps that split: a value the variable's own range
  // rejects still travels to the backend and comes back as a toast.
  function clamp(v: number | bigint): number | string {
    if (v < widgetMin) return writable(widgetMin);
    if (v > widgetMax) return writable(widgetMax);
    return writable(v);
  }

  function commit(raw: string) {
    setIsEditing(false);
    const exact = integerOf(raw);
    if (exact !== null && !Number.isSafeInteger(Number(exact))) {
      writeVariable(clamp(exact));
      return;
    }
    const parsed = parseFloat(raw);
    if (Number.isFinite(parsed)) writeVariable(clamp(parsed));
  }

  function stepBy(delta: number): number | string {
    if (exactValue !== null && Number.isInteger(delta)) return clamp(exactValue + BigInt(delta));
    return clamp(fValue! + delta);
  }

  function handleDecrement() {
    if (fValue == null) return;
    writeVariable(stepBy(-step));
  }

  function handleIncrement() {
    if (fValue == null) return;
    writeVariable(stepBy(step));
  }

  return (
    <div
      className={`hmi-component hmi-numeric-stepper${isIdle ? ' hmi-numeric-stepper--disabled' : ''}`}
      style={selfLayoutStyle(layout)}
      ref={wrapperRef}
    >
      {label && <span className="hmi-numeric-stepper__label">{label}</span>}
      <div className="hmi-numeric-stepper__row">
        <button
          type="button"
          className="hmi-numeric-stepper__btn"
          onClick={handleDecrement}
          disabled={!canDecrement}
          aria-label="Decrement"
        >
          −
        </button>
        <button
          type="button"
          className="hmi-numeric-stepper__display"
          onClick={openNumpad}
          disabled={isIdle}
          aria-label={label ? `Edit ${label}` : 'Edit value'}
        >
          <span
            className={`hmi-numeric-stepper__value${isOutOfRange ? ' hmi-numeric-stepper__value--invalid' : ''}`}
          >
            {displayValue}
          </span>
          {unit && <span className="hmi-numeric-stepper__unit">{unit}</span>}
        </button>
        <button
          type="button"
          className="hmi-numeric-stepper__btn"
          onClick={handleIncrement}
          disabled={!canIncrement}
          aria-label="Increment"
        >
          +
        </button>
      </div>
      <VirtualNumpad
        isOpen={isEditing && !isIdle}
        value={localValue}
        onChange={setLocalValue}
        onClose={commit}
        anchorRef={wrapperRef}
        title={label || undefined}
        unit={showRangeOnNumpad ? unit || undefined : undefined}
        min={showRangeOnNumpad && isFiniteBound(min) ? Number(min) : undefined}
        max={showRangeOnNumpad && isFiniteBound(max) ? Number(max) : undefined}
      />
    </div>
  );
}
