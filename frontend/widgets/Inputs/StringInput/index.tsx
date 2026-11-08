/* @jsxRuntime classic */
export const schema = {
  label: { type: 'string' as const, label: 'Label', group: 'Content' },
  placeholder: { type: 'string' as const, label: 'Placeholder', group: 'Content' },
  variable: {
    type: 'string' as const,
    label: 'Variable',
    description: 'Shows this text and writes what the operator types back to it.',
    group: 'Data',
    write: true,
  },
  writeOn: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Write on',
    description: 'Every key suits a search field that filters as the operator types.',
    display: 'button-text' as const,
    group: 'Data',
    defaultValue: 'commit',
    options: [
      { label: 'Enter or leave', value: 'commit' },
      { label: 'Every key', value: 'change' },
    ],
  },
  value: {
    type: 'string' as const,
    label: 'Value',
    description: 'What the field starts with when no Variable is bound.',
    group: 'Data',
  },
  isPassword: { type: 'boolean' as const, label: 'Password field', group: 'Appearance' },
  keyboard: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Keyboard',
    description:
      'Numeric opens the numpad instead, for digits only — a PIN or a code. Keypad draws that numpad in the field itself, so a PIN dialog is one panel.',
    display: 'button-text' as const,
    group: 'Appearance',
    defaultValue: 'text',
    options: [
      { label: 'Text', value: 'text' },
      { label: 'Numeric', value: 'numeric' },
      { label: 'Keypad', value: 'keypad' },
    ],
  },
  autoFocus: {
    type: 'boolean' as const,
    label: 'Focus when shown',
    description:
      'Opens the keyboard or numpad as soon as the field appears, as a PIN dialog wants.',
    group: 'Appearance',
  },
  disabled: { type: 'boolean' as const, label: 'Disabled', group: 'Appearance' },
  onSubmit: {
    type: 'actions' as const,
    label: 'On Submit',
    description: 'Runs on Enter, on the numpad or a physical keyboard.',
    group: 'Actions',
    event: 'onSubmit',
  },
};

export const exportedProperties: ExportedProperty[] = [
  { key: 'value', label: 'Input Value', type: 'string' },
];

export const displayName = 'String Input';
export const description =
  'A text field that writes what the operator types to a bound variable or input, and publishes it for sibling widgets to read.';
export const category = 'Inputs';
export const icon = { type: 'builtin', name: 'text-t' } as const;

export default function StringInput({ id, properties, layout }: HmiWidgetProps) {
  const evalCtx = useEvalContext();
  const scope = useHmiScope();
  const isPreview = useIsPreview();
  const varKey = bindingKey(getPropBinding(properties, 'variable'));
  const boundValue = usePropString(properties, 'variable', '');
  const writeVariable = useWriteVariable(properties, 'variable');
  const writeOnKey = usePropString(properties, 'writeOn', 'commit') === 'change';
  const initialValue = usePropString(properties, 'value', '');
  const [localValue, setLocalValue] = useState<string>(initialValue);
  // What the operator is typing, until it is committed; null shows the stored
  // value, so a bound variable changing elsewhere shows up between edits.
  const [draft, setDraft] = useState<string | null>(null);
  // Blur, a keyboard closing and Enter can all commit in one gesture; the ref
  // lets the first one through and makes the rest no-ops.
  const draftRef = useRef<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const label = getPropString(properties, 'label', '', evalCtx);
  const placeholder = getPropString(properties, 'placeholder', '', evalCtx);
  const isPassword = getPropBoolean(properties, 'isPassword', false, evalCtx);
  const disabled = getPropBoolean(properties, 'disabled', false, evalCtx);
  const keyboard = usePropString(properties, 'keyboard', 'text');
  const numeric = keyboard === 'numeric';
  const autoFocus = usePropBoolean(properties, 'autoFocus', false);

  useEffect(() => {
    setLocalValue(initialValue);
  }, [initialValue]);

  const value = draft ?? (varKey ? boundValue : localValue);
  usePublishWidgetProp(id, 'value', value);

  const store = (next: string) => {
    if (varKey) writeVariable(next);
    else setLocalValue(next);
  };
  const setValue = (next: string) => {
    draftRef.current = next;
    setDraft(next);
    if (writeOnKey) store(next);
  };
  const endEdit = () => {
    draftRef.current = null;
    setDraft(null);
  };
  const commit = () => {
    const pending = draftRef.current;
    if (pending === null) return;
    endEdit();
    if (!writeOnKey) store(pending);
  };

  // Focus opens the keyboard or numpad. Not in the editor canvas, where it
  // would pop up over the page being edited.
  useEffect(() => {
    if (autoFocus && !isPreview) inputRef.current?.focus();
  }, [autoFocus, isPreview]);

  const submit = () => {
    setIsKeyboardOpen(false);
    commit();
    const actions = (properties?.onSubmit as ActionsConfig | undefined)?.onSubmit;
    executeWidgetActions(actions, { scope, evalCtx, anchorEl: wrapperRef.current });
  };

  if (keyboard === 'keypad') {
    // The numpad is the field: always shown, Enter submits, and the entry is
    // only masked, never revealed, since there is no field to put an eye on.
    return (
      <div
        className={`hmi-component hmi-string-input${disabled ? ' hmi-string-input--disabled' : ''}`}
        style={selfLayoutStyle(layout)}
        ref={wrapperRef}
      >
        <VirtualNumpad
          inline
          isOpen
          value={value}
          onChange={setValue}
          // Actions read the entry as they start, so clearing it straight after
          // leaves a fresh keypad for the next try, as a PIN pad does.
          onApply={() => {
            submit();
            setLocalValue('');
          }}
          onCancel={() => {
            endEdit();
            setLocalValue('');
          }}
          title={label || undefined}
          currentValue={placeholder || undefined}
          decimals={0}
          allowNegative={false}
          password={isPassword}
          autoFocus={autoFocus && !isPreview}
        />
      </div>
    );
  }

  // Masked through CSS on a plain text field rather than `type="password"`:
  // that attribute is the only thing a browser keychain keys off, and every one
  // of them ignores `autocomplete="off"` when deciding to offer "save this
  // password". A panel signing operators in and out all shift has no use for a
  // keychain, so the field stays invisible to it.
  const masked = isPassword && !showPassword;
  // Except where the mask itself is unsupported — Firefox only learned
  // `-webkit-text-security` in 118, and ESR 115 still ships on Linux panels.
  // There the declaration is a no-op and the password would stand in the clear,
  // so those browsers keep a real password field: a save prompt is a smaller
  // problem than a shoulder-surfed credential.
  const maskedByCss = masked && CSS.supports('-webkit-text-security', 'disc');
  const inputType = masked && !maskedByCss ? 'password' : 'text';
  const PasswordVisibilityIcon = getBuiltinIconComponent(showPassword ? 'eye-slash' : 'eye');

  // A tap opens it too: the field keeps focus after ×, so focus alone would
  // not fire again.
  const openKeyboard = () => {
    if (!disabled) setIsKeyboardOpen(true);
  };

  return (
    <div
      className={`hmi-component hmi-string-input${disabled ? ' hmi-string-input--disabled' : ''}`}
      style={selfLayoutStyle(layout)}
      ref={wrapperRef}
    >
      {label && <label className="hmi-string-input__label">{label}</label>}
      <div className="hmi-string-input__input-row">
        <input
          className={`hmi-string-input__input${maskedByCss ? ' hmi-string-input__input--masked' : ''}`}
          ref={inputRef}
          type={inputType}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          // The numpad takes the focus and every key, as on a Number Input.
          readOnly={numeric}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore=""
          data-lpignore="true"
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setValue(e.target.value)}
          onFocus={openKeyboard}
          onBlur={commit}
          onClick={openKeyboard}
          onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur();
              submit();
            }
          }}
        />
        {isPassword && (
          <button
            type="button"
            className="hmi-string-input__eye-btn"
            onClick={() => setShowPassword((v: boolean) => !v)}
            tabIndex={-1}
          >
            {PasswordVisibilityIcon && (
              <span className="hmi-string-input__eye-icon" aria-hidden="true">
                <React.Suspense fallback={null}>
                  <PasswordVisibilityIcon size="1.25em" weight="regular" />
                </React.Suspense>
              </span>
            )}
          </button>
        )}
      </div>
      {numeric ? (
        <VirtualNumpad
          isOpen={isKeyboardOpen}
          value={value}
          onChange={setValue}
          onApply={submit}
          onCancel={() => {
            setIsKeyboardOpen(false);
            commit();
          }}
          anchorRef={wrapperRef}
          title={label || undefined}
          // Centred like Edit Value's, over the dialog a PIN field sits in.
          dockPosition="center"
          decimals={0}
          allowNegative={false}
          password={masked}
        />
      ) : (
        <VirtualKeyboard
          isOpen={isKeyboardOpen}
          value={value}
          onChange={(v: string) => {
            setValue(v);
            inputRef.current?.focus();
          }}
          onClose={() => {
            setIsKeyboardOpen(false);
            commit();
          }}
          anchorRef={wrapperRef}
          title={label || undefined}
          password={masked}
        />
      )}
    </div>
  );
}
