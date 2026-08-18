/* @jsxRuntime classic */
export const schema = {
  label: { type: 'string' as const, label: 'Label', group: 'Content' },
  options: {
    type: ['option-list', 'string[]', 'integer[]'] as const,
    label: 'Options',
    group: 'Content',
  },
  variable: {
    type: ['string', 'integer', 'float'] as const,
    label: 'Value',
    group: 'Data',
    write: true,
  },
  selectedValue: {
    type: 'string' as const,
    label: 'Selected value',
    description: 'Initial selection when no Value variable is bound.',
    group: 'Data',
  },
  disabled: { type: 'boolean' as const, label: 'Disabled', group: 'Appearance' },
  onChange: { type: 'actions' as const, label: 'On Change', event: 'onChange' },
};

export const exportedProperties: ExportedProperty[] = [
  { key: 'selectedValue', label: 'Selected value', type: 'string' },
];

export const displayName = 'Button Row';
export const description =
  'A row of mutually-exclusive buttons — pick 1 of N. Writes the chosen option to a bound variable, or tracks selection locally and fires On Change.';
export const category = 'Inputs';
export const icon = { type: 'builtin', name: 'columns' } as const;

interface OptionEntry {
  label: string;
  value: string | number;
}

function resolveOptions(raw: unknown, varValue: unknown): OptionEntry[] {
  const isVarSource =
    raw !== null &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    '$var' in (raw as Record<string, unknown>);
  const source = isVarSource ? varValue : raw;
  if (!Array.isArray(source)) return [];
  return source.map((el) => {
    if (el !== null && typeof el === 'object') {
      const entry = el as Record<string, unknown>;
      const rawValue = entry.value ?? entry.label ?? '';
      return {
        label: String(entry.label ?? entry.value ?? ''),
        value: typeof rawValue === 'number' ? rawValue : String(rawValue),
      };
    }
    return { label: String(el ?? ''), value: typeof el === 'number' ? el : String(el ?? '') };
  });
}

export default function ButtonRow({ id, properties, layout }: HmiWidgetProps) {
  const evalCtx = useEvalContext();
  const scope = useHmiScope();

  const label = usePropString(properties, 'label', '');
  const varKey = bindingKey(getPropBinding(properties, 'variable'));
  const boundValue = usePropVar(properties, 'variable');
  const propSelectedValue = usePropString(properties, 'selectedValue', '');
  const disabled = getPropBoolean(properties, 'disabled', false, evalCtx);
  const writeVariable = useWriteVariable(properties, 'variable');

  const [localSelected, setLocalSelected] = useState<string>(propSelectedValue);
  useEffect(() => {
    if (!varKey) setLocalSelected(propSelectedValue);
  }, [propSelectedValue, varKey]);

  const optionsRaw = properties?.options;
  const optionsVarBinding = (optionsRaw as { $var?: { path: string } } | undefined)?.$var ?? null;
  const optionsVarValue = useVariable(optionsVarBinding?.path ?? '');
  const options = useMemo(
    () => resolveOptions(optionsRaw, optionsVarValue),
    [optionsRaw, optionsVarValue],
  );

  const activeValue = varKey ? boundValue : localSelected;
  const activeStr = activeValue == null ? '' : String(activeValue);

  usePublishWidgetProp(id, 'selectedValue', activeStr);

  const actions = (properties?.onChange as ActionsConfig | undefined)?.onChange;

  function choose(option: OptionEntry) {
    if (disabled || String(option.value) === activeStr) return;
    // The binding test picks the mode, not permission: with no variable the
    // row still tracks its own selection and publishes it to siblings.
    if (varKey) writeVariable(option.value);
    else setLocalSelected(String(option.value));
    executeWidgetActions(actions, { scope, evalCtx });
  }

  return (
    <div
      className={`hmi-component hmi-button-row${disabled ? ' hmi-button-row--disabled' : ''}`}
      style={selfLayoutStyle(layout)}
    >
      {label && <span className="hmi-button-row__label">{label}</span>}
      <div className="hmi-button-row__items" role="group">
        {options.map((option, index) => {
          const isActive = String(option.value) === activeStr;
          return (
            <button
              key={`${index}:${option.value}`}
              type="button"
              className={`hmi-button-row__item${isActive ? ' hmi-button-row__item--active' : ''}`}
              aria-pressed={isActive}
              disabled={disabled}
              onClick={() => choose(option)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
