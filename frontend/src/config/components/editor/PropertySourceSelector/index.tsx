/**
 * PropertySourceSelector — pill button that opens a popup for choosing
 * the property source (Static, Variable, Localizable Text, If Condition, etc.)
 *
 * Placed in the property card header so the card body shows only the
 * sub-editor content.
 */

import './style.css';
import { useMemo, useRef, useState, useEffect } from 'react';
import { getAllowedPropertySources } from '@hmi/utils/propertySourceRules';
import { createSourceDefault, PROPERTY_SOURCES } from '@hmi/utils/propertySourceRegistry';
import type { PropertySource } from '@hmi/utils/propertySourceRegistry';
import { getPropertySource } from '../propertyValueUtils';
import { useComponentPropertySchema } from '../PropertySourceEditor/componentPropertySchemaContext';
import { useResultFields } from '../PropertySourceEditor/resultFieldsContext';
import useDismissOnOutsideClick from '@config/hooks/useDismissOnOutsideClick';
import { useOwnerWindow } from '@shared/components/PopoutWindow/windowContext';
import PropertySourceDrawer from './PropertySourceDrawer';
import PropertySourceBadge, { MIXED_SOURCE_LABEL, type BadgeSource } from './PropertySourceBadge';
import { propertySourceColorStyle } from './propertySourceStyle';
export type { PropertySource } from '@hmi/utils/propertySourceRegistry';

interface PropertySourceSelectorProps {
  /** The current value (plain or sourced) */
  value: unknown;
  /** Called when the source or value changes */
  onChange: (v: unknown) => void;
  /** The schema field type (string, number, boolean, color, url, icon, select) */
  fieldType: string;
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
  /** A multi-selection that disagrees on this property. `source` is the source
   *  every selected widget still shares — the trigger badges that one — or null
   *  when they disagree on the source too, which badges as "mixed" rather than
   *  naming one of them. `value` carries nothing on such a row, so the trigger
   *  must not derive its badge from it. Picking a source applies it to all. */
  mixed?: { source: PropertySource | null };
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
  mixed,
}: PropertySourceSelectorProps) {
  const [open, setOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [popupPos, setPopupPos] = useState<{
    top?: number;
    bottom?: number;
    right: number;
    maxHeight: number;
  }>({ top: 0, right: 0, maxHeight: 320 });
  const wrapperRef = useRef<HTMLDivElement>(null);
  const ownerWindow = useOwnerWindow();

  const currentSource = getPropertySource(value);
  const inputScope = useComponentPropertySchema();
  const resultFields = useResultFields();

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
    // result handler. Their type-compatibility is enforced inside the picker.
    const withScopeSources = [...normalized];
    if (baseSources.length > 0) {
      if (inputScope) withScopeSources.push('$componentProp');
      if (resultFields !== null) withScopeSources.push('$result');
    }

    const effective = Array.from(new Set(withScopeSources)).sort();

    // Optionally include 'static'
    if (includeStatic && !effective.includes('static')) {
      effective.unshift('static');
    }
    return effective;
  }, [fieldType, forcedSources, includeStatic, inputScope, resultFields]);

  // Compute fixed popup position whenever popup opens. Flips above the trigger
  // and caps the height when there isn't enough room below, so the option list
  // never spills past the viewport edge.
  useEffect(() => {
    if (open && wrapperRef.current) {
      const rect = wrapperRef.current.getBoundingClientRect();
      const margin = 8;
      const spaceBelow = ownerWindow.innerHeight - rect.bottom - margin;
      const spaceAbove = rect.top - margin;
      const below = spaceBelow >= 200 || spaceBelow >= spaceAbove;
      setPopupPos({
        top: below ? rect.bottom + 4 : undefined,
        bottom: below ? undefined : ownerWindow.innerHeight - rect.top + 4,
        right: ownerWindow.innerWidth - rect.right,
        maxHeight: Math.max(0, below ? spaceBelow : spaceAbove),
      });
    }
  }, [open, ownerWindow]);

  useDismissOnOutsideClick(wrapperRef, () => setOpen(false), open);

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
    <div className="cfg-source-pill-wrapper" ref={wrapperRef}>
      <button
        type="button"
        className={
          compact
            ? `cfg-field-group__badge-cap${isSingle ? ' cfg-source-pill--single' : ''}`
            : `cfg-source-pill${isSingle ? ' cfg-source-pill--single' : ''}`
        }
        style={propertySourceColorStyle(active)}
        onClick={() => {
          if (!isSingle) setOpen((prev) => !prev);
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

      {open && !isSingle && (
        <div
          className="cfg-source-pill__popup"
          style={{
            top: popupPos.top,
            bottom: popupPos.bottom,
            right: popupPos.right,
            maxHeight: popupPos.maxHeight,
          }}
        >
          <button
            type="button"
            className="cfg-source-pill__option cfg-source-pill__browse"
            onClick={() => {
              setOpen(false);
              setDrawerOpen(true);
            }}
          >
            <span className="cfg-source-pill__abbr">?</span>
            <span className="cfg-source-pill__option-label">Browse property sources…</span>
          </button>
          {allowedSources.map((source) => (
            <button
              key={source}
              type="button"
              className={`cfg-source-pill__option${source === active ? ' cfg-source-pill__option--active' : ''}`}
              style={propertySourceColorStyle(source)}
              onClick={() => {
                handleSourceChange(source);
                setOpen(false);
              }}
            >
              <PropertySourceBadge source={source} />
              <span className="cfg-source-pill__option-label">
                {PROPERTY_SOURCES[source].label}
              </span>
            </button>
          ))}
        </div>
      )}

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
