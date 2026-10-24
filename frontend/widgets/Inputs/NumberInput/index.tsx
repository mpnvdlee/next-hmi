/* @jsxRuntime classic */
export const schema = {
  label: { type: 'string' as const, label: 'Label', group: 'Content' },
  unit: { type: 'string' as const, label: 'Unit', group: 'Content' },
  min: { type: 'float' as const, label: 'Min value', group: 'Data' },
  max: { type: 'float' as const, label: 'Max value', group: 'Data' },
  variable: {
    type: ['float', 'integer'] as const,
    label: 'Variable',
    group: 'Data',
    write: true,
  },
  allowNegative: {
    type: 'boolean' as const,
    label: 'Allow negative values',
    group: 'Data',
    defaultValue: true,
  },
  decimals: {
    type: 'integer' as const,
    label: 'Decimal places',
    group: 'Appearance',
    min: 0,
    max: 6,
    step: 1,
  },
  showRangeOnNumpad: {
    type: 'boolean' as const,
    label: 'Show range on numpad',
    group: 'Appearance',
    defaultValue: true,
  },
  numpadPosition: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Numpad position',
    group: 'Appearance',
    defaultValue: 'bottom-right',
    options: [
      { label: 'Bottom right', value: 'bottom-right' },
      { label: 'Center', value: 'center' },
    ],
  },
};

export const displayName = 'Number Input';
export const description = 'A numeric entry field that writes a number to a variable.';
export const category = 'Inputs';
export const icon = { type: 'builtin', name: 'sliders-horizontal' } as const;

export default function NumberInput({ properties, layout }: HmiWidgetProps) {
  const evalCtx = useEvalContext();
  const meta = useVariableMeta(bindingKey(getPropBinding(properties, 'variable')));
  const value = usePropNumber(properties, 'variable', null);
  const writeVariable = useWriteVariable(properties, 'variable');
  // Only a `$var` binding writes back: with any other source the value still
  // renders, but must not look editable — the entry would be swallowed.
  const canWrite = writeVariable.canWrite;
  const isInteger = meta?.type.kind === 'scalar' && meta.type.base === 'Integer';

  const label = getPropString(properties, 'label', '', evalCtx);
  const unit = getPropString(properties, 'unit', '', evalCtx);
  const showRangeOnNumpad = getPropBoolean(properties, 'showRangeOnNumpad', true, evalCtx);
  const allowNegative = getPropBoolean(properties, 'allowNegative', true, evalCtx);
  const decimals = usePropNumber(properties, 'decimals', null);
  const numpadPosition =
    getPropString(properties, 'numpadPosition', 'bottom-right', evalCtx) === 'center'
      ? 'center'
      : 'bottom-right';

  // Widget-configured min/max win when set; otherwise fall back to the
  // range configured on the bound variable itself.
  const widgetMin = usePropNumber(properties, 'min', Number.NEGATIVE_INFINITY);
  const widgetMax = usePropNumber(properties, 'max', Number.POSITIVE_INFINITY);
  const min = Number.isFinite(widgetMin) ? widgetMin : (meta?.min ?? Number.NEGATIVE_INFINITY);
  const max = Number.isFinite(widgetMax) ? widgetMax : (meta?.max ?? Number.POSITIVE_INFINITY);

  const [localValue, setLocalValue] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // The schema's 0–6 on `decimals` is an editor hint; a binding can deliver anything.
  const places = decimals != null ? Math.min(6, Math.max(0, Math.trunc(decimals))) : undefined;
  const shownValue =
    value == null ? '---' : places !== undefined ? value.toFixed(places) : String(value);
  const displayValue = isEditing ? localValue : shownValue;
  const isOutOfRange =
    !isEditing &&
    value != null &&
    ((Number.isFinite(min) && value < min) || (Number.isFinite(max) && value > max));

  // Editing starts empty: the first key replaces the shown value instead of
  // appending to it, and the numpad shows the current one as its placeholder.
  // A tap opens it too: the field keeps focus after × or Enter, so focus alone
  // would not fire again. Already open, a tap must not wipe the entry.
  const openNumpad = () => {
    if (!canWrite || isEditing) return;
    setLocalValue('');
    setIsEditing(true);
  };

  const cancel = () => setIsEditing(false);

  // A value outside min/max is refused, never clamped: the numpad keeps it on
  // screen and says why, so a typed 5000 cannot reach the machine as 200.
  const commit = (raw: string) => {
    const parsed = parseFloat(raw);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) return;
    setIsEditing(false);
    writeVariable(parsed);
  };

  return (
    <div
      className={`hmi-component hmi-number-input${!canWrite ? ' hmi-number-input--disabled' : ''}`}
      style={selfLayoutStyle(layout)}
      ref={wrapperRef}
    >
      {label && <span className="hmi-number-input__label">{label}</span>}
      <div className="hmi-number-input__row">
        <div className="hmi-number-input__input-wrap">
          <input
            className={`hmi-number-input__field${isOutOfRange ? ' hmi-number-input__field--invalid' : ''}`}
            type="text"
            inputMode="decimal"
            value={displayValue}
            placeholder={isEditing && value != null ? shownValue : undefined}
            disabled={!canWrite}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLocalValue(e.target.value)}
            onFocus={openNumpad}
            onClick={openNumpad}
            onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter') {
                commit(e.currentTarget.value);
                e.currentTarget.blur();
              }
              if (e.key === 'Escape') {
                cancel();
                e.currentTarget.blur();
              }
            }}
          />
          {unit && <span className="hmi-number-input__unit">{unit}</span>}
        </div>
      </div>
      <VirtualNumpad
        isOpen={isEditing && canWrite}
        value={localValue}
        onChange={setLocalValue}
        onApply={commit}
        onCancel={cancel}
        anchorRef={wrapperRef}
        title={label || undefined}
        dockPosition={numpadPosition}
        unit={showRangeOnNumpad ? unit || undefined : undefined}
        min={Number.isFinite(min) ? min : undefined}
        max={Number.isFinite(max) ? max : undefined}
        showRange={showRangeOnNumpad}
        currentValue={value != null ? shownValue : undefined}
        decimals={isInteger ? 0 : places}
        allowNegative={allowNegative && !(min >= 0)}
      />
    </div>
  );
}
