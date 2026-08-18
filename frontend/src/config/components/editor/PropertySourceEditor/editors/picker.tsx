import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { useComponentOptions } from '../../WidgetOptionsContext';
import { useComponentPropertySchema } from '../componentPropertySchemaContext';
import { PickerField } from '../../../ui/PathInputField';
import { ComponentPropPath } from '../../VariableBindingPicker/ComponentPropPath';
import { widgetPropRowKey } from '../../WidgetPropPicker/rowKey';
import type { SchemaField } from '@shared/types/widgetSchema';
import type { WidgetPropSource } from '@shared/types/config';

/** $widgetProp — open WidgetPropPicker. */
export function WidgetPropEditor({
  value,
  onChange,
  schema,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  schema?: SchemaField;
}) {
  const components = useComponentOptions();
  const openPicker = useEditorDomainStore((s) => s.openWidgetPropPicker);
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
      pickTitle="Change component property"
      onPick={() =>
        openPicker(
          components,
          (componentId, property, path) =>
            onChange({ $widgetProp: { componentId, property, ...(path ? { path } : {}) } }),
          {
            fieldType: schema?.type,
            requiredFields: schema?.requiredFields,
            label: schema?.label,
            onClear: clear,
            currentKey:
              propObj.componentId && propObj.property
                ? widgetPropRowKey(propObj.componentId, propObj.property, fieldPath)
                : undefined,
          },
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
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  schema?: SchemaField;
}) {
  const ctx = useComponentPropertySchema();
  const openBindingPicker = useEditorDomainStore((s) => s.openBindingPicker);

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
    openBindingPicker('', '$componentProp', {
      componentPropSource: {
        properties: ctx.properties,
        fieldType: schema?.type,
        requiredFields: schema?.requiredFields,
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
      pickTitle="Select component property"
      onPick={ctx ? handlePick : undefined}
      onClear={selectedKey ? () => onChange(undefined) : undefined}
    />
  );
}
