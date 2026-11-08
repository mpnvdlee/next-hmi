import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { useComponentOptions } from '../../WidgetOptionsContext';
import { useComponentPropertySchema } from '../componentPropertySchemaContext';
import { PickerField } from '../../../ui/PathInputField';
import { ComponentPropPath } from '../../VariableBindingPicker/ComponentPropPath';
import { inputRowKey, widgetPropRowKey } from '../../WidgetPropPicker/rowKey';
import { slotPropFilter, type SlotType } from './utils';
import type { SchemaField } from '@shared/types/widgetSchema';
import type { WidgetPropSource } from '@shared/types/config';

/**
 * Opens the one picker a property's Input and Widget Property share: the
 * surrounding scope's Inputs, when it declares any, beside the Widget
 * Properties on this screen, the group of the source the field holds on top.
 * Picking a row of the other group switches the field to that source.
 */
function useOpenInputOrWidgetPicker(
  onChange: (v: unknown) => void,
  schema: SchemaField | undefined,
  slot: SlotType | undefined,
) {
  const ctx = useComponentPropertySchema();
  const components = useComponentOptions();
  const openPicker = useEditorDomainStore((s) => s.openWidgetPropPicker);
  return (inputsFirst: boolean, currentKey: string | undefined, onClear: () => void) =>
    openPicker(
      components,
      (componentId, property, path) =>
        onChange({ $widgetProp: { componentId, property, ...(path ? { path } : {}) } }),
      {
        ...slotPropFilter(schema, slot),
        label: schema?.label,
        onClear,
        currentKey,
        inputs: ctx
          ? {
              properties: ctx.properties,
              onPick: (key) => onChange(key ? { $componentProp: key } : undefined),
              first: inputsFirst,
            }
          : undefined,
      },
    );
}

/** $widgetProp — open WidgetPropPicker. */
export function WidgetPropEditor({
  value,
  onChange,
  schema,
  slot,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  schema?: SchemaField;
  /** The enclosing nested slot's own type, when it is not the schema's. */
  slot?: SlotType;
}) {
  const components = useComponentOptions();
  const openPicker = useOpenInputOrWidgetPicker(onChange, schema, slot);
  const propObj = (value as WidgetPropSource)?.$widgetProp ?? {
    componentId: '',
    property: '',
  };

  const comp = components.find((c) => c.id === propObj.componentId) ?? null;
  const prop = comp?.exportedProperties.find((p) => p.key === propObj.property) ?? null;
  const fieldPath = propObj.path?.trim();
  const pathDisplay =
    comp && prop
      ? `${comp.name || comp.type} › ${prop.label}` + (fieldPath ? ` / ${fieldPath}` : '')
      : '';

  const clear = () => onChange({ $widgetProp: { componentId: '', property: '' } });

  return (
    <PickerField
      displayText={pathDisplay}
      pickTitle="Change widget property"
      onPick={() =>
        openPicker(
          false,
          propObj.componentId && propObj.property
            ? widgetPropRowKey(propObj.componentId, propObj.property, fieldPath)
            : undefined,
          clear,
        )
      }
      onClear={pathDisplay ? clear : undefined}
    />
  );
}

/**
 * $componentProp — only rendered when ComponentPropertySchemaContext is active.
 * Lets the user pick one of the surrounding scope's declared component properties
 * (widget or dialog).
 */
export function ComponentPropEditor({
  value,
  onChange,
  schema,
  slot,
  withWidgetProps = false,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  schema?: SchemaField;
  /** The enclosing nested slot's own type, when it is not the schema's. */
  slot?: SlotType;
  /** A property's source, which can be a Widget Property instead: the picker
   *  offers those too. An action's field takes an Input only. */
  withWidgetProps?: boolean;
}) {
  const ctx = useComponentPropertySchema();
  const openBindingPicker = useEditorDomainStore((s) => s.openBindingPicker);
  const openBoth = useOpenInputOrWidgetPicker(onChange, schema, slot);

  const selectedKey =
    typeof (value as { $componentProp?: string })?.$componentProp === 'string'
      ? (value as { $componentProp: string }).$componentProp
      : '';

  const displayText =
    ctx && selectedKey ? (
      <ComponentPropPath value={selectedKey} properties={ctx.properties} withKeySuffix />
    ) : (
      ''
    );

  function handlePick() {
    if (!ctx) return;
    if (withWidgetProps) {
      openBoth(true, selectedKey ? inputRowKey(selectedKey) : undefined, () => onChange(undefined));
      return;
    }
    openBindingPicker('', '$componentProp', {
      componentPropSource: {
        properties: ctx.properties,
        ...slotPropFilter(schema, slot),
        label: schema?.label,
        onPick: (key: string) => onChange(key ? { $componentProp: key } : undefined),
        currentKey: selectedKey || undefined,
      },
    });
  }

  return (
    <PickerField
      displayText={displayText}
      emptyLabel="Not bound"
      pickTitle="Select input"
      onPick={ctx ? handlePick : undefined}
      onClear={selectedKey ? () => onChange(undefined) : undefined}
    />
  );
}
