/* @jsxRuntime classic */
export const schema = {
  label: { type: 'string' as const, label: 'Label', group: 'Content' },
  unit: { type: 'string' as const, label: 'Unit', group: 'Content' },
  min: { type: 'float' as const, label: 'Min value', group: 'Data' },
  max: { type: 'float' as const, label: 'Max value', group: 'Data' },
  variable: {
    type: 'struct' as const,
    label: 'Variable',
    group: 'Data',
    description:
      'Struct driving the field from the PLC: bVisible and bEnabled gate it, fValue is shown and written.',
    requiredFields: [
      { name: 'bVisible', type: 'Boolean' },
      { name: 'bEnabled', type: 'Boolean' },
      { name: 'fValue', type: 'Float', write: true },
    ],
  },
  showRangeOnNumpad: {
    type: 'boolean' as const,
    label: 'Show range on numpad',
    group: 'Appearance',
    defaultValue: true,
  },
};

export const displayName = 'Number Input';
export const description = 'A numeric entry field that writes a number to a variable.';
export const category = 'Inputs';
export const icon = { type: 'builtin', name: 'sliders-horizontal' } as const;

export default function NumberInput({ properties, layout }: HmiWidgetProps) {
  const evalCtx = useEvalContext();
  const meta = useVariableMeta(bindingKey(getPropBinding(properties, 'variable')));
  const fields = usePropStruct(properties, 'variable');
  const fieldRecord = Array.isArray(fields) ? undefined : fields;
  const writeVariable = useWriteVariable(properties, 'variable');

  const bVisible = fieldRecord?.bVisible !== false;
  // The PLC's own enable, and what the writer can actually reach: only a `$var`
  // binding writes back, so a struct arriving from any other source renders its
  // value but must not look editable — the entry would be swallowed.
  const bEnabled = fieldRecord?.bEnabled !== false && writeVariable.canWrite;
  const fValue = typeof fieldRecord?.fValue === 'number' ? fieldRecord.fValue : undefined;

  const label = getPropString(properties, 'label', '', evalCtx);
  const unit = getPropString(properties, 'unit', '', evalCtx);
  const showRangeOnNumpad = getPropBoolean(properties, 'showRangeOnNumpad', true, evalCtx);

  // Widget-configured min/max win when set; otherwise fall back to the
  // range configured on the bound variable itself.
  const widgetMin = usePropNumber(properties, 'min', Number.NEGATIVE_INFINITY);
  const widgetMax = usePropNumber(properties, 'max', Number.POSITIVE_INFINITY);
  const fieldRange = meta?.fieldRanges?.fValue;
  const min = Number.isFinite(widgetMin)
    ? widgetMin
    : (fieldRange?.min ?? Number.NEGATIVE_INFINITY);
  const max = Number.isFinite(widgetMax)
    ? widgetMax
    : (fieldRange?.max ?? Number.POSITIVE_INFINITY);

  const [localValue, setLocalValue] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isEditing) {
      setLocalValue(fValue != null ? String(fValue) : '');
    }
  }, [fValue, isEditing]);

  if (!bVisible) return null;

  const displayValue = isEditing ? localValue : fValue != null ? String(fValue) : '---';
  const isOutOfRange =
    !isEditing &&
    fValue != null &&
    ((Number.isFinite(min) && fValue < min) || (Number.isFinite(max) && fValue > max));

  const openNumpad = () => {
    if (!bEnabled) return;
    setLocalValue(fValue != null ? String(fValue) : '');
    setIsEditing(true);
  };

  // The *widget's* min/max is an authored design-time limit, so the widget
  // applies it itself — `useWriteVariable` only enforces the range configured
  // on the variable. Clamping to `widgetMin`/`widgetMax` rather than to the
  // merged `min`/`max` keeps that split: a value the variable's own range
  // rejects still travels to the backend and comes back as a toast.
  const commit = (raw: string) => {
    setIsEditing(false);
    let parsed = parseFloat(raw);
    if (!Number.isFinite(parsed)) return;
    if (parsed < widgetMin) parsed = widgetMin;
    if (parsed > widgetMax) parsed = widgetMax;
    writeVariable(parsed, { field: 'fValue' });
  };

  return (
    <div
      className={`hmi-component hmi-number-input${!bEnabled ? ' hmi-number-input--disabled' : ''}`}
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
            disabled={!bEnabled}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLocalValue(e.target.value)}
            onFocus={openNumpad}
            onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter') {
                commit(e.currentTarget.value);
                e.currentTarget.blur();
              }
              if (e.key === 'Escape') {
                setIsEditing(false);
                e.currentTarget.blur();
              }
            }}
          />
          {unit && <span className="hmi-number-input__unit">{unit}</span>}
        </div>
      </div>
      <VirtualNumpad
        isOpen={isEditing && bEnabled}
        value={localValue}
        onChange={setLocalValue}
        onClose={commit}
        anchorRef={wrapperRef}
        title={label || undefined}
        unit={showRangeOnNumpad ? unit || undefined : undefined}
        min={showRangeOnNumpad && Number.isFinite(min) ? min : undefined}
        max={showRangeOnNumpad && Number.isFinite(max) ? max : undefined}
      />
    </div>
  );
}
