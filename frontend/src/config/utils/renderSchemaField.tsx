import React from 'react';
import type { SchemaField } from '@shared/types/widgetSchema';
import ColorInput from '@config/components/editor/ColorInput';
import Select from '@config/components/ui/Select';
import PageSelect from '@config/components/ui/PageSelect';
import { getStaticString } from '@config/components/editor/propertyValueUtils';
import { primaryType } from '@shared/utils/valueTypes';
import { parseTokenVar, resolveTokenValue, tokenLabel } from '@shared/utils/themeDefaultHint';
import { IconStaticField, ImageStaticField } from './AssetStaticFields';
import { LengthField } from './LengthField';
import SlotNameField from './SlotNameField';
import BoolButtonGroup from '@config/components/ui/BoolButtonGroup';
import { hintWidthVar, NO_VALUE_LABEL } from './hintStyle';
import { withUnsetHint } from './withUnsetHint';

/** Two-state labels for boolean formats: [true label, false label].
 *
 *  `expansion` and `collapse` are the same axis read from opposite ends, and
 *  both are needed: a property named `expanded` is true when expanded, one
 *  named `collapsed` is true when collapsed. Picking one would mislabel the
 *  other's `true`. There is no `yesno` entry — that is `BoolButtonGroup`'s own
 *  default, so a field wanting Yes/No simply declares no format. */
const BOOLEAN_FORMAT_LABELS: Record<string, [string, string]> = {
  visibility: ['Visible', 'Hidden'],
  enablement: ['Enabled', 'Disabled'],
  wrap: ['Wrap', 'No wrap'],
  show: ['Show', 'Hide'],
  expansion: ['Expanded', 'Collapsed'],
  collapse: ['Collapsed', 'Expanded'],
  onoff: ['On', 'Off'],
};

/**
 * Render the static value editor for a schema field.
 * Shared between PropertiesPanel (component properties) and LayoutFields (layout).
 */
export function renderSchemaField(
  schema: SchemaField,
  value: unknown,
  onChange: (v: unknown) => void,
  /** Pre-resolved theme token values, shared across a panel's fields — see
   *  {@link usePanelTokenValues}. Falls back to a direct (uncached) resolve
   *  per field when omitted, e.g. in isolated tests. */
  tokenValues?: Record<string, string>,
  /** A multi-selection whose widgets disagree on this property. Every control
   *  reads "Mixed" instead of a value and marks no default — the widgets have
   *  values, they just aren't the same one, so "falls back to the default" would
   *  be a lie and the revert affordance would have nothing to revert to. */
  mixed = false,
): React.ReactNode {
  const type = primaryType(schema.type).toLowerCase();
  const format = schema.format;

  const effectiveValue = mixed ? undefined : (value ?? schema.defaultValue);
  // Resolved once per field — `schema`/`tokenValues` don't change across the
  // branches below, so every one reuses this instead of re-resolving (each
  // resolution can force a `getComputedStyle` read when `tokenValues` is omitted).
  // A mixed row has no fallback: that turns `withUnsetHint` into a no-op.
  const fallback = mixed ? null : resolveDefaultDisplay(schema, tokenValues);

  // Enum-picker formats all render the option dropdown / button-group.
  if (format === 'select' || format === 'direction' || format === 'align' || format === 'justify') {
    return withUnsetHint(
      value,
      onChange,
      renderSelect(schema, value, effectiveValue, onChange, shortDefaultTag(fallback), mixed),
      fallback,
      selectUsesButtonGroup(schema),
    );
  }

  // A slot name is a plain literal, never a binding — the editor tree reads it
  // straight off the definition to build the instance's slot groups. It is picked
  // from the component's declared `widgets` properties, never typed.
  if (type === 'slot') {
    return <SlotNameField value={getStaticString(value)} onChange={onChange} />;
  }

  if (type === 'string' || type === 'datetime') {
    if (format === 'page') {
      return (
        <PageSelect value={value} onChange={onChange} emptyLabel={schema.placeholder ?? '(none)'} />
      );
    }
    if (format === 'multiline') {
      return withUnsetHint(
        value,
        onChange,
        <textarea
          {...defaultAwareInput(schema, value, fallback, undefined, mixed)}
          rows={3}
          onChange={(e) => onChange(e.target.value || undefined)}
        />,
        fallback,
      );
    }
    if (format === 'password') {
      return withUnsetHint(
        value,
        onChange,
        <input
          {...defaultAwareInput(schema, value, fallback, undefined, mixed)}
          type="password"
          onChange={(e) => onChange(e.target.value || undefined)}
        />,
        fallback,
      );
    }
    if (format === 'url') {
      return withUnsetHint(
        value,
        onChange,
        <input
          {...defaultAwareInput(schema, value, fallback, 'https://...', mixed)}
          type="url"
          onChange={(e) => onChange(e.target.value || undefined)}
        />,
        fallback,
      );
    }
    if (format === 'length') {
      const unset = value === undefined || value === null || value === '';
      const lockedUnit = unset && fallback !== null;
      return withUnsetHint(
        value,
        onChange,
        <LengthField
          value={value}
          onChange={onChange}
          disabledUnit={lockedUnit}
          defaultText={unset ? fallback?.text : undefined}
          placeholder={mixed ? MIXED_LABEL : undefined}
        />,
        fallback,
      );
    }
    return withUnsetHint(
      value,
      onChange,
      <input
        {...defaultAwareInput(
          schema,
          value,
          fallback,
          type === 'datetime' ? '2026-06-15T12:00:00Z' : undefined,
          mixed,
        )}
        type="text"
        onChange={(e) => onChange(e.target.value)}
      />,
      fallback,
    );
  }

  if (type === 'date' || type === 'time') {
    return withUnsetHint(
      value,
      onChange,
      <input
        className="cfg-prop-input"
        type={type}
        value={getStaticString(effectiveValue)}
        placeholder={schema.placeholder}
        onChange={(e) => onChange(e.target.value || undefined)}
      />,
      fallback,
    );
  }

  if (type === 'duration') {
    return withUnsetHint(
      value,
      onChange,
      <input
        {...defaultAwareInput(schema, value, fallback, 'PT1H30M or 5400', mixed)}
        type="text"
        onChange={(e) => onChange(e.target.value || undefined)}
      />,
      fallback,
    );
  }

  if (type === 'integer' || type === 'float') {
    const isInteger = type === 'integer';
    const isPercentage = format === 'percentage';
    const input = (
      <input
        {...defaultAwareInput(schema, value, fallback, undefined, mixed)}
        type="number"
        min={schema.min ?? (isPercentage ? 0 : undefined)}
        max={schema.max ?? (isPercentage ? 100 : undefined)}
        step={schema.step ?? (isInteger ? 1 : 'any')}
        onChange={(e) => {
          const n = isInteger ? parseInt(e.target.value, 10) : parseFloat(e.target.value);
          onChange(isNaN(n) ? undefined : n);
        }}
      />
    );
    if (isPercentage) {
      return withUnsetHint(
        value,
        onChange,
        <span className="cfg-prop-affix">
          {input}
          <span className="cfg-prop-affix__suffix">%</span>
        </span>,
        fallback,
      );
    }
    return withUnsetHint(value, onChange, input, fallback);
  }

  if (type === 'boolean') {
    const labels = BOOLEAN_FORMAT_LABELS[format ?? ''] ?? BOOLEAN_FORMAT_LABELS.yesno;
    const rawBool = value === undefined || value === null ? undefined : Boolean(value);
    const defaultState =
      schema.defaultValue === undefined || schema.defaultValue === null
        ? undefined
        : Boolean(schema.defaultValue);
    const group = (
      <BoolButtonGroup
        value={rawBool}
        onChange={onChange}
        labels={labels}
        defaultState={defaultState}
        defaultTag={shortDefaultTag(fallback)}
        mixed={mixed}
      />
    );
    return withUnsetHint(value, onChange, mixed ? mixedRow(group) : group, fallback, true);
  }

  if (type === 'color') {
    return (
      <ColorInput
        value={value}
        onChange={onChange}
        defaultToken={schema.defaultToken}
        mixed={mixed}
      />
    );
  }

  if (type === 'icon') {
    return <IconStaticField value={value} onChange={onChange} label={schema.label} mixed={mixed} />;
  }

  // 'image' static editor — opens the image asset picker.
  if (type === 'image') {
    return (
      <ImageStaticField value={value} onChange={onChange} label={schema.label} mixed={mixed} />
    );
  }

  // 'option-list', 'actions', 'groups', 'struct', 'image-indicators',
  // 'child-positions', 'menu-items' are dispatched by SchemaFieldRow instead;
  // 'widgets' never reaches a panel row at all — `groupSchemaKeys` drops it
  return null;
}

/** The one word every control uses for "the selected widgets disagree". */
const MIXED_LABEL = 'Mixed';

/** A value no real option can carry, so a mixed dropdown matches nothing and
 *  falls through to its "Mixed" placeholder — where a plain `''` would instead
 *  select the empty "—" entry that option sets like `align` offer. */
const MIXED_SELECT_VALUE = '\u0000mixed';

/**
 * The Mixed affordance for a button group, which has no value slot to put a
 * placeholder in: every option dims (see `--alt` / `mixed` in the group itself)
 * and the word sits where the `· default` suffix normally would, in the same
 * muted hint span the rest of the panel uses.
 */
function mixedRow(control: React.ReactNode): React.ReactNode {
  return (
    <div className="cfg-prop-affix cfg-unset-hint-row">
      {control}
      <span className="cfg-unset-hint">{MIXED_LABEL}</span>
    </div>
  );
}

/** Whether a `select`-format schema renders as a button group rather than a `<Select>` dropdown. */
function selectUsesButtonGroup(schema: SchemaField): boolean {
  const options = schema.options ?? [];
  const display = schema.display ?? 'auto';
  return (
    display === 'button-text' ||
    display === 'button-icon' ||
    (display === 'auto' && options.length > 0 && options.every((o) => o.icon))
  );
}

/** Short "default" word for the tag rendered inside a button group's default option. */
function shortDefaultTag(fallback: { text: string; suffix: string } | null): string | undefined {
  return fallback ? 'default' : undefined;
}

/**
 * Render a single-pick dropdown / button-group for a `format: 'select'` string field.
 * `rawValue` is the stored value (unset-aware — drives default marking); `value`
 * is the defaulted value used for the active/selected state. `defaultTag` is the
 * short word ("default" / "theme") shown inside the option the field falls back to.
 * `mixed` reads as its own state: no option is selected or marked, and the group
 * says "Mixed" rather than looking like an untouched field.
 */
function renderSelect(
  schema: SchemaField,
  rawValue: unknown,
  value: unknown,
  onChange: (v: unknown) => void,
  defaultTag?: string,
  mixed = false,
): React.ReactNode {
  const options = schema.options ?? [];
  const currentVal = getStaticString(value);

  // Unset + a real schema default → mark the option the default resolves to
  // and dim the rest, instead of showing it as an explicit selection.
  const unset = rawValue === undefined || rawValue === null || rawValue === '';
  const defaultText =
    schema.defaultValue === undefined || schema.defaultValue === null
      ? undefined
      : getStaticString(schema.defaultValue);
  const markDefault = !mixed && unset && defaultText !== undefined;

  const display = schema.display ?? 'auto';
  const useButtonGroup = selectUsesButtonGroup(schema);
  const showIcon =
    display === 'button-icon' || (display === 'auto' && options.every((o) => o.icon));

  if (useButtonGroup) {
    const group = (
      <div className="cfg-seg-group">
        {options.map((o) => {
          const optVal = String(o.value);
          const isDefault = markDefault && optVal === defaultText;
          const isAlt = mixed || (markDefault && !isDefault);
          const active = !mixed && !markDefault && optVal === currentVal;
          return (
            <button
              key={optVal || '__none__'}
              type="button"
              title={showIcon ? o.label : undefined}
              className={`cfg-seg-btn${active ? ' cfg-seg-btn--active' : ''}${
                isDefault ? ' cfg-seg-btn--default' : ''
              }${isAlt ? ' cfg-seg-btn--alt' : ''}`}
              onClick={() => onChange(o.value)}
            >
              {showIcon && o.icon ? renderIcon(o.icon) : o.label}
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
    return mixed ? mixedRow(group) : group;
  }

  return (
    <Select
      value={mixed ? MIXED_SELECT_VALUE : currentVal}
      placeholder={mixed ? MIXED_LABEL : undefined}
      onChange={(raw) => {
        const match = options.find((o) => String(o.value) === raw);
        onChange(match ? match.value : raw);
      }}
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </Select>
  );
}

/** Render a button-group icon: SVG strings are injected as innerHTML, plain strings as text. */
function renderIcon(icon: string): React.ReactNode {
  if (icon.trimStart().startsWith('<')) {
    return <span className="cfg-seg-btn__icon" dangerouslySetInnerHTML={{ __html: icon }} />;
  }
  return <span className="cfg-seg-btn__icon">{icon}</span>;
}

/**
 * Shared props for any free-text control that can express its unset default
 * in-place: the fallback value moves into the placeholder (so it reads grey at
 * the value's own position) instead of sitting in `value` as black text that
 * looks like an explicit setting. The `· default` / `· default(…)` suffix stays a
 * separate `.cfg-unset-hint` span — it renders a size down from the value, and
 * a placeholder can only be styled as one run. `--hint` makes the control hug
 * that placeholder so the span lands directly behind it.
 */
function defaultAwareInput(
  schema: SchemaField,
  value: unknown,
  fallback: { text: string; suffix: string } | null,
  typePlaceholder?: string,
  mixed = false,
) {
  const hint = mixed ? MIXED_LABEL : fallback?.text || schema.placeholder || typePlaceholder;
  // Last resort: a field with no default and no schema hint would render as an
  // empty box, which reads as a rendering failure rather than as "this property
  // has no value" — the state every other unset field spells out ("0 · default",
  // "auto · default"). It is a state label rather than a stand-in value, so it
  // renders at the `· default` suffix's size, not the control's.
  const placeholder = hint || NO_VALUE_LABEL;
  const unset = value === undefined || value === null || value === '';
  const hugging = Boolean(fallback) && unset;
  return {
    className: `cfg-prop-input${hugging ? ' cfg-prop-input--hint' : ''}${
      hint ? '' : ' cfg-prop-input--no-value'
    }`,
    value: getStaticString(value),
    placeholder,
    style: hugging ? hintWidthVar(placeholder) : undefined,
  };
}

/** Resolved human display for a schema's default — the value text plus its source label. */
export function resolveDefaultDisplay(
  schema: SchemaField,
  tokenValues?: Record<string, string>,
): { text: string; suffix: string } | null {
  // A theme-token default (`defaultToken`, a bare `--hmi-*` cssVar) or a
  // `var(--hmi-*)`-shaped `defaultValue` both resolve to the same themed hint.
  // Every unset field says "default" — the word for *where* the default comes
  // from would be noise; the token name in parens is the part carrying meaning,
  // since the resolved text ("0.5rem") doesn't reveal which token supplied it.
  const cssVar = schema.defaultToken ?? parseTokenVar(schema.defaultValue);
  if (cssVar) {
    const text = tokenValues?.[cssVar] ?? resolveTokenValue(cssVar);
    return { text, suffix: `default(${tokenLabel(cssVar)})` };
  }
  const raw = schema.defaultValue;
  if (raw === undefined || raw === null || raw === '') return null;
  return { text: String(raw), suffix: 'default' };
}
