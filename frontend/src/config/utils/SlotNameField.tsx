import Select from '@config/components/ui/Select';
import { useComponentPropertySchema } from '@config/components/editor/PropertySourceEditor/componentPropertySchemaContext';
import { DEFAULT_SLOT_KEY } from '@hmi/components/ComponentSlot/slotKey';
import { primaryType } from '@shared/utils/valueTypes';

/**
 * Editor for a `ComponentSlot`'s slot name.
 *
 * A slot is part of the component's declared interface: the definition adds a
 * `widgets` component property and this field picks it. The name the panel row
 * shows on an instance and the name the slot renders under are therefore the
 * same string by construction — there is no free-typed name to drift from the
 * declaration.
 *
 * The picker is an affordance over a plain literal, never a gate on it: the
 * widget is a normal registry entry that can also be dropped on a page, and
 * definitions written before `widgets` properties existed name their slots
 * freely. Where there is nothing to pick from, the name stays typeable, and a
 * name matching no declaration stays selected rather than reading as unset —
 * either way the stored value is visible and only the author can change it.
 */
export default function SlotNameField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string | undefined) => void;
}) {
  const schema = useComponentPropertySchema();
  const declared = Object.entries(schema?.properties ?? {}).filter(
    ([, field]) => primaryType(field.type).toLowerCase() === 'widgets',
  );

  if (declared.length === 0) {
    return (
      <div className="cfg-slot-name-field">
        <input
          className="cfg-prop-input"
          value={value}
          placeholder={DEFAULT_SLOT_KEY}
          onChange={(e) => onChange(e.target.value || undefined)}
        />
        <p className="cfg-prop-hint">
          {schema
            ? 'Add a “Widget slot” property to this component, then pick it here.'
            : 'Only a component definition can fill a slot — on a page this stays empty.'}
        </p>
      </div>
    );
  }

  return (
    <Select value={value} onChange={(v) => onChange(v || undefined)}>
      <option value="">(pick a slot)</option>
      {declared.map(([key, field]) => (
        <option key={key} value={key}>
          {field.label ? `${field.label} (${key})` : key}
        </option>
      ))}
      {value && !declared.some(([key]) => key === value) && (
        <option value={value}>{value} (not declared)</option>
      )}
    </Select>
  );
}
