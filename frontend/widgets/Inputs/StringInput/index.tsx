/* @jsxRuntime classic */
export const schema = {
  label: { type: 'string' as const, label: 'Label', group: 'Content' },
  placeholder: { type: 'string' as const, label: 'Placeholder', group: 'Content' },
  isPassword: { type: 'boolean' as const, label: 'Password field', group: 'Appearance' },
  disabled: { type: 'boolean' as const, label: 'Disabled', group: 'Appearance' },
};

export const exportedProperties: ExportedProperty[] = [
  { key: 'value', label: 'Input Value', type: 'string' },
];

export const displayName = 'String Input';
export const description =
  'A text field whose typed value is published for sibling widgets to read.';
export const category = 'Inputs';
export const icon = { type: 'builtin', name: 'text-t' } as const;

export default function StringInput({ id, properties, layout }: HmiWidgetProps) {
  const evalCtx = useEvalContext();
  const [value, setValue] = useState<string>('');
  const [showPassword, setShowPassword] = useState(false);
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const label = getPropString(properties, 'label', '', evalCtx);
  const placeholder = getPropString(properties, 'placeholder', '', evalCtx);
  const isPassword = getPropBoolean(properties, 'isPassword', false, evalCtx);
  const disabled = getPropBoolean(properties, 'disabled', false, evalCtx);

  usePublishWidgetProp(id, 'value', value);

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
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore=""
          data-lpignore="true"
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setValue(e.target.value)}
          onFocus={() => {
            if (!disabled) setIsKeyboardOpen(true);
          }}
          onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter') {
              setIsKeyboardOpen(false);
              e.currentTarget.blur();
            }
          }}
        />
        {isPassword && (
          <button
            type="button"
            className="hmi-string-input__eye-btn"
            aria-label={showPassword ? 'Hide password' : 'Show password'}
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
      <VirtualKeyboard
        isOpen={isKeyboardOpen}
        value={value}
        onChange={(v: string) => {
          setValue(v);
          inputRef.current?.focus();
        }}
        onClose={() => setIsKeyboardOpen(false)}
        anchorRef={wrapperRef}
        title={label || undefined}
        password={masked}
      />
    </div>
  );
}
