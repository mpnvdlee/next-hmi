import { useState, type CSSProperties, type ReactNode } from 'react';
import './componentProperty.css';
import '../editor/BindingPickerShell/style.css';
import {
  componentPropertyToSchemaField,
  inputMode,
  isStructInput,
  OPTION_TYPE_EMPTY_VALUE,
  OPTION_TYPE_OPTIONS,
  propertyTypeLabel,
  VALUELESS_PROPERTY_TYPES,
  type ComponentPropertyOptionType,
  type ComponentPropertySchema,
  type InputMode,
  type StructSchemaNode,
} from '@shared/types/componentProperty';
import { primaryType } from '@shared/utils/valueTypes';
import { hasOptionValue, renderSchemaField, selectOptionKey } from '../../utils/renderSchemaField';
import PropRow from '../ui/PropRow';
import FieldGroup from '../ui/FieldGroup';
import AddButton from '../ui/AddButton';
import BoolButtonGroup from '../ui/BoolButtonGroup';
import { ClearIcon, EditIcon } from '../ui/actionIcons';
import propertySourceIcons from '../editor/PropertySourceSelector/propertySourceIcons';
import { KindLabel, PreviewText } from '../editor/PropertySourceEditor/editors/shared';
import RequiredFieldsTree from '../editor/VariableBindingPicker/RequiredFieldsTree';
import Select from '../ui/Select';
import ItemsInput, { type ItemEntry } from '../editor/ItemsInput';
import { PropertyModal } from './PropertyModal';
import { StructSchemaModal } from './StructSchemaModal';

interface Props {
  properties: Record<string, ComponentPropertySchema>;
  /** Name of the component or dialog these properties belong to. */
  ownerName?: string;
  /** What this interface is called where it is being edited. */
  title?: string;
  /** Singular form of `title`, for the add and delete controls. */
  itemNoun?: string;
  /** Who declares these, which decides the help text. A page of the Pages
   *  section: only Navigate To Page fills its inputs, and nothing can be
   *  written back, so every input is a Value and the choice is not offered. */
  owner?: InputOwner;
  onChange: (next: Record<string, ComponentPropertySchema>) => void;
}

export default function ComponentPropertiesEditor({
  properties,
  ownerName,
  title = 'Inputs',
  itemNoun = 'input',
  owner = 'component',
  onChange,
}: Props) {
  const [addingProp, setAddingProp] = useState(false);
  const [editingStructKey, setEditingStructKey] = useState<string | null>(null);
  // Expansion lives here, keyed by property key, so the row a property was just
  // added under opens with the editor already showing.
  const [expandedKeys, setExpandedKeys] = useState<Record<string, boolean>>({});

  const propertyEntries = Object.entries(properties);

  function handleAddProperty(
    key: string,
    label: string,
    declared: Pick<ComponentPropertySchema, 'type' | 'format'>,
    defaultValue?: unknown,
  ) {
    if (properties[key]) return;
    const newProp: ComponentPropertySchema = {
      ...declared,
      label,
      ...(declared.type === 'struct' ? { structSchema: [] } : {}),
      ...(defaultValue !== undefined ? { defaultValue } : {}),
    };
    onChange({ ...properties, [key]: newProp });
    setExpandedKeys((prev) => ({ ...prev, [key]: true }));
    setAddingProp(false);
  }

  function handleDeleteProperty(key: string) {
    const { [key]: _removed, ...rest } = properties;
    onChange(rest);
  }

  function handlePatchProperty(key: string, patch: Partial<ComponentPropertySchema>) {
    onChange({
      ...properties,
      [key]: { ...properties[key], ...patch },
    });
  }

  function handleConfirmStructSchema(key: string, schema: StructSchemaNode[]) {
    handlePatchProperty(key, { structSchema: schema });
    setEditingStructKey(null);
  }

  const editingStructSchema = editingStructKey ? properties[editingStructKey] : null;

  return (
    <>
      {/* The last block of its owner's first section, titled like a field: the
          same title row as an action list's "On Pressed + Add". */}
      <div className="cfg-editor-actions">
        <div className="cfg-editor-actions__title-row">
          <span className="cfg-field-group__label">{title}</span>
          <AddButton title={`Add ${itemNoun}`} onClick={() => setAddingProp(true)} />
        </div>

        {propertyEntries.length === 0 && (
          <div className="cfg-prop-hint cfg-component-prop-empty">No {itemNoun}s yet</div>
        )}

        {propertyEntries.map(([key, schema]) => (
          <ComponentPropertyRow
            key={key}
            propKey={key}
            schema={schema}
            owner={owner}
            onChange={(patch) => handlePatchProperty(key, patch)}
            onDelete={() => handleDeleteProperty(key)}
            onEditStructSchema={() => setEditingStructKey(key)}
            expanded={!!expandedKeys[key]}
            onExpandedChange={(next) => setExpandedKeys((prev) => ({ ...prev, [key]: next }))}
          />
        ))}
      </div>

      {addingProp && (
        <PropertyModal
          existingKeys={Object.keys(properties)}
          contextName={ownerName}
          onConfirm={handleAddProperty}
          onCancel={() => setAddingProp(false)}
        />
      )}

      {editingStructKey && editingStructSchema && (
        <StructSchemaModal
          propKey={editingStructKey}
          initialSchema={(editingStructSchema.structSchema ?? []) as StructSchemaNode[]}
          onConfirm={(schema) => handleConfirmStructSchema(editingStructKey, schema)}
          onCancel={() => setEditingStructKey(null)}
        />
      )}
    </>
  );
}

/** A default value as a property's summary line states it: a string quoted,
 *  a list by its length, a structured value not at all. */
function defaultText(value: unknown): string {
  if (typeof value === 'string') return `"${value}"`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  return '';
}

const MODE_OPTIONS: { value: InputMode; label: string }[] = [
  { value: 'value', label: 'Value' },
  { value: 'binding', label: 'Binding' },
];

const MODE_LABEL: Record<InputMode, string> = { value: 'Value', binding: 'Binding' };

type InputOwner = 'component' | 'dialog' | 'page';

/** How each owner's input is set, and where its description and default show. */
const OWNER_TEXT: Record<InputOwner, { hint?: string; description: string; default: string }> = {
  component: {
    description: "Shown under this property's label wherever the component is placed.",
    default: 'Used wherever an instance leaves this property unset.',
  },
  dialog: {
    hint: 'Set by Open Dialog.',
    description: "Shown under this input's name in the Open Dialog action.",
    default: 'Used when Open Dialog leaves this input empty.',
  },
  page: {
    hint: 'Set by Navigate To Page. Without it, this default. Read once, then local.',
    description: "Shown under this input's name in the Navigate To Page action.",
    default:
      'Used when Navigate To Page leaves this input empty, and whenever the page is reached another way.',
  },
};

function ComponentPropertyRow({
  propKey,
  schema,
  owner,
  onChange,
  onDelete,
  onEditStructSchema,
  expanded,
  onExpandedChange,
}: {
  propKey: string;
  schema: ComponentPropertySchema;
  owner: InputOwner;
  onChange: (patch: Partial<ComponentPropertySchema>) => void;
  onDelete: () => void;
  onEditStructSchema: () => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const primary = primaryType(schema.type);
  const optionType = schema.optionType ?? 'string';
  const mode = inputMode(schema);
  const valueOnly = owner === 'page';
  const text = OWNER_TEXT[owner];
  const fixedMode = valueOnly || isStructInput(primary);

  function changeOptionType(next: ComponentPropertyOptionType) {
    // The labels are the author's work, so the rows stay — but a value written
    // for the old kind describes nothing under the new one, and a leftover
    // string where the list now promises a number is worse than a blank.
    const options = (schema.options ?? []).map((option) => ({
      ...option,
      value: OPTION_TYPE_EMPTY_VALUE[next],
    }));
    // Only an option the pickers actually offer can keep the default alive —
    // a blanked row holds nothing, and its key is `''`, which an empty-string
    // default would otherwise match all the way into a translation list.
    const defaultStillOffered = options.some(
      (option) =>
        hasOptionValue(option.value) &&
        selectOptionKey(option.value) === selectOptionKey(schema.defaultValue),
    );
    onChange({
      // Absent reads as `string`, which keeps an ordinary select's file as it
      // was written before the other kinds existed.
      optionType: next === 'string' ? undefined : next,
      options,
      ...(defaultStillOffered ? {} : { defaultValue: undefined }),
    });
  }

  return (
    <FieldGroup
      tier={3}
      drawerTitle={schema.label || propKey}
      badge={<ComponentPropBadge />}
      kindLabel={<KindLabel>{schema.label || propKey}</KindLabel>}
      summary={
        <PreviewText>
          <span className="cfg-component-prop-summary">
            {schema.label || propKey}
            <span className="cfg-component-prop-summary__meta">
              {' · '}
              {propertyTypeLabel(schema)}
              {defaultText(schema.defaultValue) && (
                <>
                  {' · '}
                  <span className="cfg-component-prop-summary__default">
                    {defaultText(schema.defaultValue)}
                  </span>
                </>
              )}
            </span>
          </span>
        </PreviewText>
      }
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      actions={
        <button
          className="cfg-row-action-btn cfg-row-action-btn--stretch"
          type="button"
          title="Delete property"
          onClick={onDelete}
        >
          <ClearIcon />
        </button>
      }
    >
      {/* Key and type are fixed at creation — every reference elsewhere is
          written against them, so both are stated bare: a field box that cannot
          be typed into reads as a broken input. */}
      <StatedRow label="Key">{propKey}</StatedRow>

      <StatedRow label="Type">{propertyTypeLabel(schema)}</StatedRow>

      {/* A struct is a variable folder, so always a Binding. A page's input
          has nothing to write back to — the button that navigated is gone —
          so it is always a Value, and the choice is not offered at all. */}
      {mode &&
        !valueOnly &&
        (fixedMode ? (
          <StatedRow label="Kind">{MODE_LABEL[mode]}</StatedRow>
        ) : (
          <PropRow
            label="Kind"
            description={
              mode === 'value'
                ? 'Read once when opened, then this screen’s own; never written back.'
                : 'A variable, followed live and written through to it.'
            }
            tier={2}
            sourceless
          >
            <Select
              value={mode}
              onChange={(next) =>
                onChange(
                  next === 'value'
                    ? { mode: 'value', write: undefined }
                    : { mode: 'binding', defaultValue: undefined },
                )
              }
            >
              {MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </PropRow>
        ))}
      {text.hint && <div className="cfg-prop-hint">{text.hint}</div>}

      {primary === 'struct' && (
        <PropRow
          label="Struct schema"
          sourceless
          block
          actions={
            <button
              className="cfg-row-action-btn cfg-row-action-btn--stretch"
              type="button"
              title="Edit struct schema"
              onClick={onEditStructSchema}
            >
              <EditIcon />
            </button>
          }
        >
          <StructSchemaSummary schema={(schema.structSchema ?? []) as StructSchemaNode[]} />
        </PropRow>
      )}

      <PropRow label="Label" sourceless>
        <input
          className="cfg-prop-input"
          type="text"
          value={schema.label}
          placeholder={propKey}
          onChange={(e) => onChange({ label: e.target.value })}
        />
      </PropRow>

      <PropRow label="Description" description={text.description} sourceless>
        <input
          className="cfg-prop-input"
          type="text"
          value={schema.description ?? ''}
          placeholder="(none)"
          onChange={(e) => onChange({ description: e.target.value || undefined })}
        />
      </PropRow>

      {/* Only a Binding writes a variable: a Value is written locally, a struct
          declares write access per field, and a page input binds no variable.
          The flag is what limits the picker to writable variables (see
          VariableBindingPicker). */}
      {mode === 'binding' && !fixedMode && schema.format !== 'page' && (
        <PropRow
          label="Write access"
          description="Only allow binding to a variable the component may write."
          sourceless
        >
          <BoolButtonGroup
            value={schema.write === true}
            onChange={(write) => onChange({ write: write || undefined })}
          />
        </PropRow>
      )}

      {primary === 'select' && (
        <>
          <PropRow
            label="Option values"
            description="What each option holds, and so what the property resolves to."
            tier={2}
            sourceless
          >
            <Select
              value={optionType}
              onChange={(next) => changeOptionType(next as ComponentPropertyOptionType)}
            >
              {OPTION_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </PropRow>

          <PropRow label="Options" block sourceless>
            <ItemsInput
              valueType={optionType}
              plainLabels
              value={schema.options ?? []}
              onChange={(options) => onChange({ options: options as typeof schema.options })}
            />
          </PropRow>
        </>
      )}

      {/* These have no single literal to fall back to — a struct resolves to a
          variable subtree, an actions list to handlers, a widgets property to
          whatever the caller drops in the slot, a Binding to the variable the
          caller names. */}
      {!VALUELESS_PROPERTY_TYPES.has(primary) && (mode !== 'binding' || valueOnly) && (
        <PropRow
          label="Default value"
          description={text.default}
          sourceless
          block={primary === 'option-list'}
        >
          {primary === 'option-list' ? (
            <ItemsInput
              value={schema.defaultValue as ItemEntry[] | undefined}
              onChange={(defaultValue) => onChange({ defaultValue })}
            />
          ) : (
            renderSchemaField(
              componentPropertyToSchemaField({ ...schema, defaultValue: undefined }),
              schema.defaultValue,
              (v) => onChange({ defaultValue: v }),
            )
          )}
        </PropRow>
      )}
    </FieldGroup>
  );
}

/** A label over a value the editor states rather than accepts — same label and
 *  spacing as a `PropRow`, minus the field box. */
function StatedRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="cfg-component-prop-stated-row">
      <div className="cfg-field-group__label">{label}</div>
      <span className="cfg-component-prop-stated">{children}</span>
    </div>
  );
}

/** Badge cap for a property row — the `$componentProp` glyph in its own tint,
 *  since these rows define exactly what that source reads. */
function ComponentPropBadge() {
  return (
    <span
      className="cfg-field-group__badge-cap"
      title="Input"
      style={{ '--option-color': 'var(--cfg-source-componentProp)' } as CSSProperties}
    >
      {propertySourceIcons.$componentProp}
    </span>
  );
}

/** The schema as the binding picker's "Required" panel states it — same rows,
 *  same indent, same type/access badges, so an author reads one shape whether
 *  they are declaring the struct here or matching it against a variable there. */
function StructSchemaSummary({ schema }: { schema: StructSchemaNode[] }) {
  if (schema.length === 0) {
    return <div className="cfg-prop-hint cfg-component-prop-empty">No fields defined.</div>;
  }
  const fields = componentPropertyToSchemaField({
    type: 'struct',
    label: '',
    structSchema: schema,
  }).requiredFields;
  if (!fields?.length) {
    return <div className="cfg-prop-hint cfg-component-prop-empty">No fields defined.</div>;
  }
  return (
    <div className="cfg-component-prop-struct-tree">
      <RequiredFieldsTree fields={fields} />
    </div>
  );
}
