import type { SchemaField } from '@shared/types/widgetSchema';
import type {
  ActionsConfig,
  ChildPosition,
  ImageIndicator,
  MenuItemConfig,
  WidgetConfig,
} from '@shared/types/config';
import { structVarDefault } from '@hmi/utils/bindingValidation';
import { SOURCE_CAPABLE_TYPES } from '@hmi/utils/propertySourceRules';
import { primaryType, isStructType } from '@shared/utils/valueTypes';
import { evaluateVisibility } from '../../../utils/visibilityEvaluator';
import { renderSchemaField } from '../../../utils/renderSchemaField';
import { useFieldDiagnostic } from '@config/hooks/usePanelDiagnostics';
import { PanelScopeContext } from '@config/store/panelExpansionStore';
import { useContext } from 'react';
import PropertySourceEditor, { type OpenBindingPicker } from '../../editor/PropertySourceEditor';
import { ParentPathContext } from '../../editor/PropertySourceEditor/parentPathContext';
import PropertySourceSelector, { type PropertySource } from '../../editor/PropertySourceSelector';
import PropertySourceBadge from '../../editor/PropertySourceSelector/PropertySourceBadge';
import { getPropertySource } from '../../editor/propertyValueUtils';
import ActionsInput from '../../editor/PropertiesPanel/ActionsInput';
import MenuItemsInput from '../../editor/PropertiesPanel/MenuItemsInput';
import GroupsField from '../GroupsField';
import ImageIndicatorsEditor from '../../editor/ImageIndicatorsEditor';
import ChildPositionsEditor from '../../editor/ChildPositionsEditor';
import ItemsInput, { type ItemEntry } from '../../editor/ItemsInput';
import PageGroupSelect from '../PageGroupSelect';
import PropRow from '../PropRow';
import FieldGroup from '../FieldGroup';
import { sourceFieldGroupProps } from '../FieldGroup/sourceFieldProps';

interface Props {
  schema: SchemaField;
  value: unknown;
  onChange: (v: unknown) => void;
  /** Opens the variable-binding picker (or another picker) for sourced / struct fields. */
  onOpenPicker?: OpenBindingPicker;
  /** Sibling property values used for visibility-condition evaluation. */
  allProperties?: Record<string, unknown>;
  /** Selection identity for per-parameter copy/paste. Rows without a key
   *  (e.g. synthetic shell-region editors) cannot be selected. */
  propKey?: string;
  /** Full selection/copy-paste path. Overrides the default `[propKey]` — used
   *  for nested fields such as layout (`[LAYOUT_PATH_KEY, key]`). */
  path?: string[];
  /** Raw child WidgetConfigs of the parent component — required for
   *  schema fields that operate on the parent's children (e.g. `child-positions`). */
  childConfigs?: WidgetConfig[];
  /** Object-name/identifier field (e.g. page/page-group title) — hides the badge. */
  sourceless?: boolean;
  /** Pre-resolved theme token values shared across the panel's fields — see
   *  {@link usePanelTokenValues}. */
  tokenValues?: Record<string, string>;
  /** The selected widgets disagree on this property. The row shows "Mixed" in place
   *  of a value and stays editable — one edit writes to all of them. Distinct from
   *  an unset value, which shows its resolved default. `source` is null when the
   *  widgets disagree on the property source as well. */
  mixed?: { source: PropertySource | null };
}

/**
 * Renders one schema field as a row in the right-hand properties panel. Used by
 * the page editor's PropertiesPanel and the components editor's CompositionWidgetPanel.
 *
 * Layout decisions, top to bottom:
 * - Hidden when `schema.visibleWhen` evaluates false against `allProperties`.
 * - `image-indicators` / `child-positions` / `page-group` / `groups` → bare PropRow (tier-1, no card).
 * - `actions` → plain label + `ActionsInput` directly, no wrapping box (each action is
 *   already its own boxed `FieldGroup` — see `ActionRow`).
 * - Otherwise → tier-3 `FieldGroup` with badge (real source pill when switchable, plain static
 *   badge otherwise), collapsed summary, `⤢` drawer, and the PropertySourceEditor body.
 *   Struct fields default to `$var` and accept `$componentProp` automatically
 *   when a ComponentPropertySchemaContext is active.
 * - A `mixed` row (multi-selection) shows "Mixed" instead of a value and offers no
 *   revert, since "revert to default" is not "leave the widgets disagreeing".
 */
export default function SchemaFieldRow({
  schema,
  value,
  onChange,
  onOpenPicker,
  allProperties = {},
  propKey,
  path: pathProp,
  childConfigs,
  sourceless,
  tokenValues,
  mixed,
}: Props) {
  // A mixed row has no value at all: falling back to the schema default would
  // present one widget's setting as if it were shared.
  const effectiveValue = mixed ? undefined : value === undefined ? schema.defaultValue : value;
  const fieldType = primaryType(schema.type).toLowerCase();
  const widgetId = useContext(PanelScopeContext);
  const path = pathProp ?? (propKey != null ? [propKey] : undefined);
  const diagnostic = useFieldDiagnostic(widgetId, path);
  const selection = path ? { path, schema } : undefined;

  if (!evaluateVisibility(schema.visibleWhen, allProperties)) return null;

  if (fieldType === 'image-indicators') {
    return (
      <PropRow
        label={schema.label}
        description={schema.description}
        selection={selection}
        sourceless={sourceless}
      >
        <ImageIndicatorsEditor
          value={value as ImageIndicator[] | undefined}
          src={allProperties.src}
          onChange={onChange as (v: ImageIndicator[]) => void}
        />
      </PropRow>
    );
  }

  if (fieldType === 'child-positions') {
    return (
      <PropRow
        label={schema.label}
        description={schema.description}
        selection={selection}
        sourceless={sourceless}
      >
        <ChildPositionsEditor
          value={value as ChildPosition[] | undefined}
          src={allProperties.src}
          childConfigs={childConfigs}
          onChange={onChange as (v: ChildPosition[]) => void}
        />
      </PropRow>
    );
  }

  if (fieldType === 'page-group') {
    return (
      <PropRow
        label={schema.label}
        description={schema.description}
        selection={selection}
        sourceless={sourceless}
      >
        <PageGroupSelect
          value={effectiveValue}
          onChange={onChange}
          placeholder={schema.placeholder}
        />
      </PropRow>
    );
  }

  // A slot name is a plain literal, never a binding, so it takes no source pill.
  if (fieldType === 'slot') {
    return (
      <PropRow
        label={schema.label}
        description={schema.description}
        selection={selection}
        sourceless={sourceless}
      >
        {renderSchemaField(schema, value, onChange, tokenValues)}
      </PropRow>
    );
  }

  // Same collapsible shape as the `$userGroups` source (colored summary
  // of the checked group labels while collapsed; the checkbox list itself only
  // when expanded).
  if (fieldType === 'groups') {
    return (
      <GroupsField
        label={schema.label}
        description={schema.description}
        value={value}
        onChange={onChange}
        selection={selection}
        sourceless={sourceless}
      />
    );
  }

  // Same case as the action list below: every row is its own boxed FieldGroup,
  // and the list as a whole has no single value to badge, summarize or collapse.
  if (fieldType === 'menu-items') {
    return (
      <div className="cfg-field-group">
        <MenuItemsInput
          value={value as MenuItemConfig[] | undefined}
          onChange={onChange as (v: MenuItemConfig[]) => void}
          title={schema.label}
          description={schema.description}
          pathPrefix={path}
        />
      </div>
    );
  }

  const isSourceCapable = SOURCE_CAPABLE_TYPES.has(fieldType);
  // A struct binding: any named (non-scalar, non-editor-kind) type — `struct`,
  // `Alarms[]`, or an array/struct type a custom widget declares. Both bind a
  // single `$var` / `$componentProp` and render as a path input + picker, not an
  // empty tier-3 box. Source-capable types (scalars, `record-list`, …) keep their
  // own editors, so they are excluded even though `record-list` is struct-like.
  const isStruct = isStructType(fieldType) && !isSourceCapable;
  const detectedSource = mixed
    ? mixed.source
    : isSourceCapable || isStruct
      ? (getPropertySource(effectiveValue) as PropertySource | null)
      : null;
  const currentSource = isSourceCapable ? detectedSource : null;

  // Struct fields default to $var, but when authoring inside a component-property
  // scope (widget or dialog) the user can bind via $componentProp instead. The
  // body editor and source pill stay in sync via the detected source.
  const structSource: PropertySource =
    isStruct && detectedSource === '$componentProp' ? '$componentProp' : '$var';
  const structValueForEditor = isStruct
    ? structSource === '$var'
      ? structVarDefault(effectiveValue)
      : effectiveValue
    : undefined;

  const hasSourcePill = isSourceCapable || isStruct;
  const titleText =
    fieldType === 'actions' && schema.label === 'Actions' ? 'On Pressed' : schema.label;

  // An action list has no single value of its own to badge/summarize/collapse —
  // each action is already its own boxed FieldGroup (see ActionRow). Matches the
  // sandbox's trigger-block: a plain header line directly above the action list,
  // no wrapping box for the group itself.
  if (fieldType === 'actions') {
    return (
      <div className="cfg-field-group">
        <ActionsInput
          value={value as ActionsConfig | undefined}
          onChange={onChange}
          eventKey={schema.event ?? 'onPress'}
          eventLabel={titleText}
          headerTitle={titleText}
          description={schema.description}
          pathPrefix={path}
        />
      </div>
    );
  }

  // Content-tier shape drives whether the row is a plain inline control
  // (tier 1/2) or an expandable multi-field box (tier 3) — see the redesign
  // doc's Content-tier model. Sourceless compound fields (`actions`,
  // `groups`) are handled above and never reach this fallback.
  const sourceForTier = isSourceCapable ? currentSource : isStruct ? structSource : null;
  const { tier, summary, kindLabel, drawerTitle } = sourceFieldGroupProps({
    source: sourceForTier,
    title: titleText,
    value: effectiveValue,
    fieldType,
    mixed: mixed !== undefined,
  });
  // Composite fields start collapsed on every page load; the session expand
  // store (FieldGroup) remembers any the user opens while the page stays open.
  const defaultExpanded = false;

  const badge = sourceless ? undefined : hasSourcePill ? (
    <PropertySourceSelector
      value={isStruct ? structValueForEditor : effectiveValue}
      onChange={onChange}
      fieldType={fieldType}
      defaultValue={schema.defaultValue}
      forcedSources={isStruct ? (['$var'] as PropertySource[]) : undefined}
      includeStatic={!isStruct && fieldType !== 'record-list'}
      showWhenSingle={isStruct}
      label={schema.label}
      // A struct row binds one way whatever the selection disagrees about, so it
      // badges the source its body actually renders. `mixed.source` is derived
      // from the raw values, where an unbound widget reads as `static` — a source
      // this row does not even offer.
      mixed={isStruct && mixed ? { source: structSource } : mixed}
      compact
    />
  ) : (
    <PropertySourceBadge source="static" variant="cap" />
  );

  // Widgets that disagree on the source have no editor to show — picking one from
  // the pill is the only meaningful next step, and it applies to all of them.
  const body =
    isSourceCapable && currentSource === null ? (
      <p className="cfg-prop-hint">Mixed sources — pick one to apply to every selection.</p>
    ) : isSourceCapable ? (
      <ParentPathContext.Provider value={path}>
        <PropertySourceEditor
          value={effectiveValue}
          onChange={onChange}
          source={currentSource!}
          onOpenBindingPicker={onOpenPicker}
          schema={schema}
          staticEditor={
            currentSource === 'static' ? (
              fieldType === 'option-list' ? (
                <ItemsInput
                  value={effectiveValue as ItemEntry[] | undefined}
                  onChange={onChange as (v: ItemEntry[]) => void}
                />
              ) : (
                // Raw `value` (not the defaulted `effectiveValue`) so the
                // static editor can tell unset apart from an explicit
                // override and show the unset→default hint accordingly.
                // A mixed row instead reads "Mixed" on whichever control it
                // renders and offers no revert — "revert to default" and
                // "leave the widgets disagreeing" are different things.
                renderSchemaField(schema, value, onChange, tokenValues, mixed !== undefined)
              )
            ) : undefined
          }
        />
      </ParentPathContext.Provider>
    ) : isStruct ? (
      <ParentPathContext.Provider value={path}>
        <PropertySourceEditor
          value={structValueForEditor}
          onChange={onChange}
          source={structSource}
          onOpenBindingPicker={onOpenPicker}
          schema={schema}
        />
      </ParentPathContext.Provider>
    ) : null;

  return (
    <FieldGroup
      label={titleText}
      description={schema.description}
      tier={tier}
      selection={selection}
      sourceless={sourceless}
      defaultExpanded={defaultExpanded}
      diagnostic={diagnostic}
      summary={summary}
      kindLabel={kindLabel}
      badge={badge}
      drawerTitle={drawerTitle}
    >
      {body}
    </FieldGroup>
  );
}
