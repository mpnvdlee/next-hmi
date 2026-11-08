/**
 * PropertySourceSelector — pill button that opens the source drawer for
 * choosing the property source (Static, Variable, Localizable Text, If
 * Condition, etc.), as the action list's Add opens its type drawer.
 *
 * Placed in the property card header so the card body shows only the
 * sub-editor content.
 */

import './style.css';
import { useMemo, useState } from 'react';
import { getAllowedPropertySources } from '@hmi/utils/propertySourceRules';
import { createSourceDefault, PROPERTY_SOURCES } from '@hmi/utils/propertySourceRegistry';
import type { PropertySource } from '@hmi/utils/propertySourceRegistry';
import { getPropertySource } from '../propertyValueUtils';
import { useComponentPropertySchema } from '../PropertySourceEditor/componentPropertySchemaContext';
import { useResultFields } from '../PropertySourceEditor/resultFieldsContext';
import { useRepeatEditorScope } from '../PropertySourceEditor/repeatScopeContext';
import PropertySourceDrawer from './PropertySourceDrawer';
import PropertySourceBadge, { MIXED_SOURCE_LABEL, type BadgeSource } from './PropertySourceBadge';
import { propertySourceColorStyle } from './propertySourceStyle';
export type { PropertySource } from '@hmi/utils/propertySourceRegistry';

interface PropertySourceSelectorProps {
  /** The current value (plain or sourced) */
  value: unknown;
  /** Called when the source or value changes */
  onChange: (v: unknown) => void;
  /** The schema field type (string, number, boolean, color, url, icon, select),
   *  or a union of them — the drawer offers what fits any one of them. */
  fieldType: string | readonly string[];
  /** Optional schema-level default value used when creating a new source payload */
  defaultValue?: unknown;
  /** Optional explicit list of sources to show (bypasses fieldType matrix) */
  forcedSources?: PropertySource[];
  /** Whether to include the static source in the computed list (default: true) */
  includeStatic?: boolean;
  /** Show selector even when there is only one option */
  showWhenSingle?: boolean;
  /** Render only the badge icon (no label/arrow) — fills a `FieldGroup` badge slot. */
  compact?: boolean;
  /** Property name the browse drawer shows before its own action. */
  label?: string;
  /** The source the row is already rendering, when that is not simply what the
   *  value's shape says — a `select` whose options hold translations stores a
   *  `{ $loc }` the row reads as a static pick. The pill must agree, or picking
   *  the source already in effect counts as a switch and overwrites the value
   *  with a fresh default. Absent, the value's own shape decides, as before. */
  source?: PropertySource;
  /** A multi-selection that disagrees on this property. `source` is the source
   *  every selected widget still shares — the trigger badges that one — or null
   *  when they disagree on the source too, which badges as "mixed" rather than
   *  naming one of them. `value` carries nothing on such a row, so the trigger
   *  must not derive its badge from it. Picking a source applies it to all. */
  mixed?: { source: PropertySource | null };
  /** Which of the context-offered sources (`$componentProp`, `$result`,
   *  `$repeatItem`) may join the list. Default: all of them. */
  scopeSources?: PropertySource[];
}

export default function PropertySourceSelector({
  value,
  onChange,
  fieldType,
  defaultValue,
  forcedSources,
  includeStatic = true,
  showWhenSingle = false,
  compact = false,
  label,
  source,
  mixed,
  scopeSources,
}: PropertySourceSelectorProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  const currentSource = source ?? getPropertySource(value);
  const inputScope = useComponentPropertySchema();
  const resultFields = useResultFields();
  const repeatScope = useRepeatEditorScope();

  // Get allowed sources for this field type
  const allowedSources = useMemo(() => {
    const baseSources = forcedSources ?? getAllowedPropertySources(fieldType);

    let normalized = baseSources
      .map((s) => (s === '$static' ? 'static' : s) as PropertySource)
      .filter((source): source is PropertySource => source in PROPERTY_SOURCES);

    // Widget children may not bind `$var` directly — they read values via
    // `$componentProp`. Dialog children leave `forbidVar` false.
    if (inputScope?.forbidVar) {
      normalized = normalized.filter((source) => source !== '$var');
    }

    // Flexible scope sources are offered by ambient context, not by field type:
    // `$componentProp` inside a widget/dialog scope, `$result` inside an action
    // result handler, `$repeatItem` inside a Repeater. Their type-compatibility
    // is enforced inside the picker.
    const withScopeSources = [...normalized];
    const joins = (s: PropertySource) => !scopeSources || scopeSources.includes(s);
    if (baseSources.length > 0) {
      if (inputScope && joins('$componentProp')) withScopeSources.push('$componentProp');
      if (resultFields !== null && joins('$result')) withScopeSources.push('$result');
      if (repeatScope && joins('$repeatItem')) withScopeSources.push('$repeatItem');
    }

    const effective = Array.from(new Set(withScopeSources)).sort();

    // Optionally include 'static'
    if (includeStatic && !effective.includes('static')) {
      effective.unshift('static');
    }
    return effective;
  }, [
    fieldType,
    forcedSources,
    includeStatic,
    inputScope,
    resultFields,
    repeatScope,
    scopeSources,
  ]);

  function handleSourceChange(newSource: PropertySource) {
    if (!allowedSources.includes(newSource)) return;

    let newValue: unknown;
    if (newSource === 'static') {
      // A mixed row's `value` is nothing at all, so keeping it would clear every
      // selected widget instead of giving them one shared static value.
      if (!mixed && currentSource === 'static') {
        newValue = value;
      } else {
        newValue = createSourceDefault('static', fieldType, defaultValue);
      }
    } else {
      newValue = createSourceDefault(newSource, fieldType, defaultValue);
    }

    onChange(newValue);
  }

  const isSingle = allowedSources.length <= 1;

  // When there is only one allowed source and showWhenSingle is false, render nothing.
  if (!showWhenSingle && isSingle) {
    return null;
  }

  // A mixed row carries its source beside the (absent) value — reading `value`
  // there would badge every such row "static". `null` means the widgets disagree
  // on the source itself, which badges as "mixed" and matches no option.
  const active: BadgeSource = mixed ? (mixed.source ?? 'mixed') : (currentSource ?? 'static');
  const activeEntry = active === 'mixed' ? undefined : PROPERTY_SOURCES[active];

  return (
    <div className="cfg-source-pill-wrapper">
      <button
        type="button"
        className={
          compact
            ? `cfg-field-group__badge-cap${isSingle ? ' cfg-source-pill--single' : ''}`
            : `cfg-source-pill${isSingle ? ' cfg-source-pill--single' : ''}`
        }
        style={propertySourceColorStyle(active)}
        onClick={() => {
          if (!isSingle) setDrawerOpen(true);
        }}
        title={activeEntry?.label ?? MIXED_SOURCE_LABEL}
      >
        <PropertySourceBadge source={active} variant={compact ? 'cap' : 'pill'} />
        {!compact && (
          <>
            <span className="cfg-source-pill__label">
              {activeEntry ? (activeEntry.short ?? activeEntry.label) : 'Mixed'}
            </span>
            {!isSingle && (
              <svg
                className="cfg-source-pill__arrow"
                width="9"
                height="9"
                viewBox="0 0 10 10"
                aria-hidden="true"
              >
                <path
                  d="M2 3.5 L5 6.5 L8 3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </>
        )}
      </button>

      {drawerOpen && (
        <PropertySourceDrawer
          label={label}
          sources={allowedSources}
          activeSource={active === 'mixed' ? null : active}
          onClose={() => setDrawerOpen(false)}
          onSelect={(source) => {
            handleSourceChange(source);
            setDrawerOpen(false);
          }}
        />
      )}
    </div>
  );
}
