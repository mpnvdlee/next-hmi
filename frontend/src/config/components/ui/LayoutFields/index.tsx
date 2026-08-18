import type { LayoutConfig } from '@shared/types/config';
import type { SchemaField } from '@shared/types/widgetSchema';
import type { PropertySource } from '@hmi/utils/propertySourceRegistry';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { varBindingOf } from '@config/components/editor/bindingPickerUtils';
import { LAYOUT_PATH_KEY } from '@config/utils/propertyPath';
import SchemaFieldRow from '../SchemaFieldRow';
import { CONTAINER_DEFAULT_TOKENS } from './containerDefaultTokens';

const ALIGN_OPTIONS = [
  { label: '—', value: '' },
  { label: 'Start', value: 'flex-start' },
  { label: 'Center', value: 'center' },
  { label: 'End', value: 'flex-end' },
  { label: 'Stretch', value: 'stretch' },
];

const JUSTIFY_OPTIONS = [
  { label: '—', value: '' },
  { label: 'Start', value: 'flex-start' },
  { label: 'Center', value: 'center' },
  { label: 'End', value: 'flex-end' },
  { label: 'Space between', value: 'space-between' },
  { label: 'Space around', value: 'space-around' },
];

const ALIGN_SELF_FIELD: SchemaField = {
  type: 'String',
  format: 'align',
  label: 'Align self',
  display: 'button-text',
  defaultValue: 'auto',
  options: [
    { label: '—', value: '' },
    { label: 'Auto', value: 'auto' },
    { label: 'Start', value: 'flex-start' },
    { label: 'Center', value: 'center' },
    { label: 'End', value: 'flex-end' },
    { label: 'Stretch', value: 'stretch' },
  ],
};

const DIRECTION_FIELD: SchemaField = {
  type: 'String',
  format: 'direction',
  label: 'Direction',
  display: 'button-text',
  defaultValue: 'row',
  options: [
    { label: 'Row', value: 'row' },
    { label: 'Column', value: 'column' },
  ],
};

type LayoutKey = keyof LayoutConfig;
type FieldGroup = 'container' | 'self';

interface LayoutFieldDef {
  key: LayoutKey;
  schema: SchemaField;
  group: FieldGroup;
}

const FIELDS: LayoutFieldDef[] = [
  // Container — hidden when mode === 'leaf'
  { key: 'direction', schema: DIRECTION_FIELD, group: 'container' },
  {
    key: 'gap',
    schema: { type: 'String', format: 'length', label: 'Gap', placeholder: 'e.g. 1rem' },
    group: 'container',
  },
  {
    key: 'wrap',
    schema: { type: 'Boolean', format: 'wrap', label: 'Wrap', defaultValue: false },
    group: 'container',
  },
  {
    key: 'align',
    schema: {
      type: 'String',
      format: 'align',
      label: 'Align items',
      display: 'button-text',
      defaultValue: 'stretch',
      options: ALIGN_OPTIONS,
    },
    group: 'container',
  },
  {
    key: 'justify',
    schema: {
      type: 'String',
      format: 'justify',
      label: 'Justify content',
      display: 'button-text',
      defaultValue: 'flex-start',
      options: JUSTIFY_OPTIONS,
    },
    group: 'container',
  },
  {
    key: 'padding',
    schema: { type: 'String', format: 'length', label: 'Padding' },
    group: 'container',
  },
  {
    key: 'paddingTop',
    schema: { type: 'String', format: 'length', label: 'Padding top' },
    group: 'container',
  },
  {
    key: 'paddingRight',
    schema: { type: 'String', format: 'length', label: 'Padding right' },
    group: 'container',
  },
  {
    key: 'paddingBottom',
    schema: { type: 'String', format: 'length', label: 'Padding bottom' },
    group: 'container',
  },
  {
    key: 'paddingLeft',
    schema: { type: 'String', format: 'length', label: 'Padding left' },
    group: 'container',
  },
  {
    key: 'radius',
    schema: { type: 'String', format: 'length', label: 'Radius' },
    group: 'container',
  },

  // Self — sizing
  {
    key: 'width',
    schema: {
      type: 'String',
      format: 'length',
      label: 'Width',
      placeholder: 'e.g. 200px or 100%',
      defaultValue: 'auto',
    },
    group: 'self',
  },
  {
    key: 'minWidth',
    schema: {
      type: 'String',
      format: 'length',
      label: 'Min width',
      placeholder: 'e.g. 100px',
      defaultValue: '0',
    },
    group: 'self',
  },
  {
    key: 'maxWidth',
    schema: {
      type: 'String',
      format: 'length',
      label: 'Max width',
      placeholder: 'e.g. 400px',
      defaultValue: 'none',
    },
    group: 'self',
  },
  {
    key: 'height',
    schema: {
      type: 'String',
      format: 'length',
      label: 'Height',
      placeholder: 'e.g. 80px',
      defaultValue: 'auto',
    },
    group: 'self',
  },
  {
    key: 'minHeight',
    schema: {
      type: 'String',
      format: 'length',
      label: 'Min height',
      placeholder: 'e.g. 80px',
      defaultValue: '0',
    },
    group: 'self',
  },

  // Self — spacing
  {
    key: 'margin',
    schema: { type: 'String', format: 'length', label: 'Margin' },
    group: 'self',
  },
  {
    key: 'marginTop',
    schema: { type: 'String', format: 'length', label: 'Margin top' },
    group: 'self',
  },
  {
    key: 'marginRight',
    schema: { type: 'String', format: 'length', label: 'Margin right' },
    group: 'self',
  },
  {
    key: 'marginBottom',
    schema: { type: 'String', format: 'length', label: 'Margin bottom' },
    group: 'self',
  },
  {
    key: 'marginLeft',
    schema: { type: 'String', format: 'length', label: 'Margin left' },
    group: 'self',
  },

  // Self — flex placement
  { key: 'alignSelf', schema: ALIGN_SELF_FIELD, group: 'self' },
  {
    key: 'basis',
    schema: {
      type: 'String',
      format: 'length',
      label: 'Basis',
      placeholder: 'e.g. 200px',
      defaultValue: 'auto',
    },
    group: 'self',
  },
  {
    key: 'grow',
    schema: { type: 'Integer', label: 'Grow', min: 0, step: 1, defaultValue: 0 },
    group: 'self',
  },
  {
    key: 'shrink',
    schema: { type: 'Integer', label: 'Shrink', min: 0, step: 1, defaultValue: 1 },
    group: 'self',
  },
];

interface LayoutProps {
  mode: 'container' | 'leaf';
  layout: Partial<LayoutConfig>;
  onChange: (patch: Partial<LayoutConfig>) => void;
  /** Owning component id — enables the variable-binding picker for `$var`
   *  layout values. A multi-selection passes its lead: the id only scopes the
   *  picker's preselect, while the pick itself is applied through `onChange`.
   *  Omitted in composition authoring (where `$var` is forbidden). */
  componentId?: string;
  /** Pre-resolved theme token values, shared with the rest of the panel — see
   *  {@link usePanelTokenValues}. Falls back to a direct (uncached) resolve per
   *  field when omitted. */
  tokenValues?: Record<string, string>;
  /** Layout keys a multi-selection disagrees on, mapped to the source the widgets
   *  still share (null when they differ there too). Those rows read "Mixed" and
   *  ignore `layout`, which carries only the lead widget's values. */
  mixedLayout?: ReadonlyMap<keyof LayoutConfig, PropertySource | null>;
}

// Margin is the one 'self' field (shown on both container and leaf widgets) whose
// CSS default differs by mode: containers get the same `--hmi-space-sm` token as
// their padding/gap (see frontend/widgets/Layout/Container/style.css), while a plain leaf widget's
// `.hmi-component` rule sets no margin at all — a bare CSS initial of 0.
const LEAF_MARGIN_DEFAULTS: Partial<Record<keyof LayoutConfig, string>> = {
  margin: '0',
  marginTop: '0',
  marginRight: '0',
  marginBottom: '0',
  marginLeft: '0',
};

export function LayoutFields({
  mode,
  layout,
  onChange,
  componentId,
  tokenValues,
  mixedLayout,
}: LayoutProps) {
  const openBindingPicker = useEditorDomainStore((s) => s.openBindingPicker);
  const visible = FIELDS.filter((f) => f.group === 'self' || mode === 'container');

  // The container token-defaults only apply to Container widgets. Attaching the
  // token as `defaultToken` gives layout rows the same unset→`· default(…)` hint +
  // `×` revert as component props, with the resolved value shown as the
  // (length format's own) placeholder.
  function schemaFor(f: LayoutFieldDef): SchemaField {
    const token = mode === 'container' ? CONTAINER_DEFAULT_TOKENS[f.key] : undefined;
    if (token) return { ...f.schema, defaultToken: token };
    const leafDefault = mode === 'leaf' ? LEAF_MARGIN_DEFAULTS[f.key] : undefined;
    return leafDefault !== undefined ? { ...f.schema, defaultValue: leafDefault } : f.schema;
  }

  return (
    <>
      {visible.map((f) => {
        // The row's single writer. The picker routes through it too, so a picked
        // binding lands wherever a typed edit would — including on every widget
        // of a multi-selection.
        const commit = (v: unknown) =>
          onChange({
            [f.key]: v === '' || v === undefined ? undefined : (v as LayoutConfig[typeof f.key]),
          });
        return (
          <SchemaFieldRow
            key={f.key}
            schema={schemaFor(f)}
            value={mixedLayout?.has(f.key) ? undefined : layout[f.key]}
            mixed={mixedLayout?.has(f.key) ? { source: mixedLayout.get(f.key) ?? null } : undefined}
            path={[LAYOUT_PATH_KEY, f.key]}
            onChange={commit}
            onOpenPicker={
              componentId
                ? (onPick, currentBinding) =>
                    openBindingPicker(componentId, `${LAYOUT_PATH_KEY}.${f.key}`, {
                      // Layout values live on `comp.layout`, not `comp.properties`,
                      // so the picker can neither read this binding back nor write
                      // it back itself — a slot that opened the picker without a
                      // callback of its own gets `commit` instead of the picker's
                      // `properties[propertyKey]` fallback.
                      onPick: onPick ?? ((binding) => commit({ $var: binding })),
                      filter: { label: f.schema.label, type: f.schema.type },
                      // A nested slot inside the value overrides with its own binding.
                      currentBinding: currentBinding ?? varBindingOf(layout[f.key]),
                    })
                : undefined
            }
            tokenValues={tokenValues}
          />
        );
      })}
    </>
  );
}
