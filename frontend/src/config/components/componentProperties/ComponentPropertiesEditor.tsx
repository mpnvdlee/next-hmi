import { useState, type CSSProperties, type ReactNode } from 'react';
import './componentProperty.css';
import '../editor/BindingPickerShell/style.css';
import {
  componentPropertyToSchemaField,
  type ComponentPropertySchema,
  type StructSchemaNode,
} from '@shared/types/componentProperty';
import { primaryType } from '@shared/utils/valueTypes';
import { renderSchemaField } from '../../utils/renderSchemaField';
import PropRow from '../ui/PropRow';
import FieldGroup from '../ui/FieldGroup';
import AddButton from '../ui/AddButton';
import BoolButtonGroup from '../ui/BoolButtonGroup';
import { ClearIcon, EditIcon } from '../ui/actionIcons';
import propertySourceIcons from '../editor/PropertySourceSelector/propertySourceIcons';
import { KindLabel, PreviewText } from '../editor/PropertySourceEditor/editors/shared';
import RequiredFieldsTree from '../editor/VariableBindingPicker/RequiredFieldsTree';
import ItemsInput, { type ItemEntry } from '../editor/ItemsInput';
import { PropertyModal } from './PropertyModal';
import { StructSchemaModal } from './StructSchemaModal';

/** Property types that never resolve to a single literal value, so they take
 *  neither a write flag nor a default. */
const VALUELESS_TYPES = new Set(['struct', 'actions', 'widgets']);

interface Props {
  properties: Record<string, ComponentPropertySchema>;
  /** Name of the component or dialog these properties belong to. */
  ownerName?: string;
  onChange: (next: Record<string, ComponentPropertySchema>) => void;
}

export default function ComponentPropertiesEditor({ properties, ownerName, onChange }: Props) {
  const [addingProp, setAddingProp] = useState(false);
  const [editingStructKey, setEditingStructKey] = useState<string | null>(null);
  // Expansion lives here, keyed by property key, so the row a property was just
  // added under opens with the editor already showing.
  const [expandedKeys, setExpandedKeys] = useState<Record<string, boolean>>({});

  const propertyEntries = Object.entries(properties);

  function handleAddProperty(key: string, label: string, type: string) {
    if (properties[key]) return;
    const newProp: ComponentPropertySchema = {
      type,
      label,
      ...(type === 'struct' ? { structSchema: [] } : {}),
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
      <div className="cfg-section">
        <div className="cfg-component-props__title-row">
          <span className="cfg-section__title">Component Properties</span>
          <AddButton title="Add component property" onClick={() => setAddingProp(true)} />
        </div>

        {propertyEntries.length === 0 && (
          <div className="cfg-prop-hint cfg-component-prop-empty">No component properties yet.</div>
        )}

        {propertyEntries.map(([key, schema]) => (
          <ComponentPropertyRow
            key={key}
            propKey={key}
            schema={schema}
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

function ComponentPropertyRow({
  propKey,
  schema,
  onChange,
  onDelete,
  onEditStructSchema,
  expanded,
  onExpandedChange,
}: {
  propKey: string;
  schema: ComponentPropertySchema;
  onChange: (patch: Partial<ComponentPropertySchema>) => void;
  onDelete: () => void;
  onEditStructSchema: () => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const primary = primaryType(schema.type);

  return (
    <FieldGroup
      tier={3}
      drawerTitle={schema.label || propKey}
      badge={<ComponentPropBadge />}
      kindLabel={<KindLabel>{schema.label || propKey}</KindLabel>}
      summary={<PreviewText>{schema.label || propKey}</PreviewText>}
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

      <StatedRow label="Type">{schema.type}</StatedRow>

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

      <PropRow
        label="Description"
        description="Shown under this property's label wherever the component is placed."
        sourceless
      >
        <input
          className="cfg-prop-input"
          type="text"
          value={schema.description ?? ''}
          placeholder="(none)"
          onChange={(e) => onChange({ description: e.target.value || undefined })}
        />
      </PropRow>

      {/* A struct declares write access per field, and an actions or widgets
          property binds no variable at all — for everything else the flag is what
          limits the picker to writable variables (see VariableBindingPicker). */}
      {!VALUELESS_TYPES.has(primary) && (
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
        <PropRow label="Options" block sourceless>
          <ItemsInput
            value={(schema.options ?? []) as ItemEntry[]}
            onChange={(opts) => onChange({ options: opts })}
          />
        </PropRow>
      )}

      {/* These have no single literal to fall back to — a struct resolves to a
          variable subtree, an actions list to handlers, a widgets property to
          whatever the caller drops in the slot. */}
      {!VALUELESS_TYPES.has(primary) && (
        <PropRow
          label="Default value"
          description="Used wherever an instance leaves this property unset."
          sourceless
        >
          {renderSchemaField(
            componentPropertyToSchemaField({ ...schema, defaultValue: undefined }),
            schema.defaultValue,
            (v) => onChange({ defaultValue: v }),
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
      title="Component property"
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
