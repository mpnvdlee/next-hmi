interface BoolButtonGroupProps {
  value: boolean | undefined;
  onChange: (next: boolean) => void;
  /** [true label, false label] — defaults to Yes / No. */
  labels?: [string, string];
  /** Resolved schema/theme default. While `value` is unset the option this
   *  resolves to is marked as the one in effect and the other dims, matching
   *  the unset→default affordance used across the panel. */
  defaultState?: boolean;
  /** Short "default" / "theme" word shown inside the marked default option. */
  defaultTag?: string;
  /** A multi-selection whose widgets disagree: neither option is in effect, so
   *  both dim and none is marked as the default. The word "Mixed" is the row's
   *  job — see `mixedRow` in `renderSchemaField`. */
  mixed?: boolean;
}

/** Two-state button group for boolean settings, replacing bare checkboxes. */
export default function BoolButtonGroup({
  value,
  onChange,
  labels = ['Yes', 'No'],
  defaultState,
  defaultTag,
  mixed = false,
}: BoolButtonGroupProps) {
  const unset = value === undefined || value === null;
  const marked = !mixed && unset && defaultState !== undefined;
  return (
    <div className="cfg-seg-group">
      {([true, false] as const).map((state) => {
        const active = !mixed && !unset && value === state;
        const isDefault = marked && defaultState === state;
        const isAlt = mixed || (marked && !isDefault);
        return (
          <button
            key={String(state)}
            type="button"
            className={`cfg-seg-btn${active ? ' cfg-seg-btn--active' : ''}${
              isDefault ? ' cfg-seg-btn--default' : ''
            }${isAlt ? ' cfg-seg-btn--alt' : ''}`}
            onClick={() => onChange(state)}
          >
            {state ? labels[0] : labels[1]}
            {isDefault && defaultTag ? (
              <span className="cfg-seg-btn__tag" aria-hidden="true">
                {defaultTag}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
