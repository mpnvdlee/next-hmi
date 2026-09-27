/**
 * PropertySourceEditor — renders the appropriate sub-editor for the current property source.
 *
 * Sub-editors live under ./editors/. This file is the dispatch table only.
 */

import React, { type ReactNode } from 'react';
import type { SchemaField } from '@shared/types/widgetSchema';
import type { PropertySource } from '../propertyValueUtils';
import {
  AlarmCountEditor,
  DeviceFieldEditor,
  LanguagesEditor,
  LocEditor,
  PageEditor,
  PageIsActiveEditor,
  RandomEditor,
  RecipeEditor,
  RecipeListEditor,
  RepeatItemEditor,
  ResultEditor,
  TimeEditor,
  UrlParamEditor,
  UserFieldEditor,
  UserGroupsEditor,
  VarEditor,
  ViewportEditor,
} from './editors/leaf';
import { CompareEditor, IfEditor, NotEditor, SwitchEditor } from './editors/conditional';
import { WidgetPropEditor, ComponentPropEditor } from './editors/picker';
import { StringExprEditor } from './editors/stringExpr';
import { FormulaEditor } from './editors/formula';
import { HttpEditor } from './editors/http';
import type { OpenBindingPicker, SlotType } from './editors/utils';
import { useSlotType } from './slotContext';
import { primaryType } from '@shared/utils/valueTypes';

export { CollapsedPreview, KindLabel, PreviewText } from './editors/shared';
export { PickerField } from '../../ui/PathInputField';
export type { OpenBindingPicker } from './editors/utils';

interface PropertySourceEditorProps {
  /** Current value (plain or sourced) */
  value: unknown;
  /** Called when value changes */
  onChange: (v: unknown) => void;
  /** Current property source */
  source: PropertySource | null;
  /** Optional: base value editor for the 'static' source */
  staticEditor?: ReactNode;
  /** Optional: callback to open the variable binding picker overlay. */
  onOpenBindingPicker?: OpenBindingPicker;
  /** Schema field, used for nested branch editors ($if / $switch) */
  schema?: SchemaField;
}

type SourceEditorRenderer = (props: {
  value: unknown;
  onChange: (v: unknown) => void;
  schema?: SchemaField;
  /** The type(s) the value may have, which narrow a source's `field` choices;
   *  absent for a slot that takes any type. */
  fieldType?: string | readonly string[];
  /** The enclosing nested slot's own type, when it is not the schema's. */
  slot?: SlotType;
  onOpenBindingPicker?: OpenBindingPicker;
  staticEditor?: ReactNode;
}) => React.ReactNode;

const SOURCE_EDITORS: Record<PropertySource, SourceEditorRenderer> = {
  static: ({ staticEditor }) =>
    staticEditor ? <div className="cfg-property-source-editor__static">{staticEditor}</div> : null,
  $var: ({ value, onChange, onOpenBindingPicker }) => (
    <VarEditor value={value} onChange={onChange} onOpenBindingPicker={onOpenBindingPicker} />
  ),
  $loc: ({ value, onChange }) => <LocEditor value={value} onChange={onChange} />,
  $urlParam: ({ value, onChange }) => <UrlParamEditor value={value} onChange={onChange} />,
  $pageIsActive: ({ value, onChange }) => <PageIsActiveEditor value={value} onChange={onChange} />,
  $if: ({ value, onChange, schema, onOpenBindingPicker }) => (
    <IfEditor
      value={value}
      onChange={onChange}
      schema={schema}
      onOpenBindingPicker={onOpenBindingPicker}
    />
  ),
  $compare: ({ value, onChange, onOpenBindingPicker }) => (
    <CompareEditor value={value} onChange={onChange} onOpenBindingPicker={onOpenBindingPicker} />
  ),
  $not: ({ value, onChange, onOpenBindingPicker }) => (
    <NotEditor value={value} onChange={onChange} onOpenBindingPicker={onOpenBindingPicker} />
  ),
  $formula: ({ value, onChange, onOpenBindingPicker }) => (
    <FormulaEditor value={value} onChange={onChange} onOpenBindingPicker={onOpenBindingPicker} />
  ),
  $random: ({ value, onChange }) => <RandomEditor value={value} onChange={onChange} />,
  $switch: ({ value, onChange, schema, onOpenBindingPicker }) => (
    <SwitchEditor
      value={value}
      onChange={onChange}
      schema={schema}
      onOpenBindingPicker={onOpenBindingPicker}
    />
  ),
  $user: ({ value, onChange, schema, fieldType }) => (
    <UserFieldEditor
      value={value}
      onChange={onChange}
      fieldType={fieldType}
      listOnly={
        schema !== undefined &&
        ['option-list', 'item-list'].includes(primaryType(schema.type).toLowerCase())
      }
    />
  ),
  $userGroups: ({ value, onChange }) => <UserGroupsEditor value={value} onChange={onChange} />,
  $device: ({ value, onChange, fieldType }) => (
    <DeviceFieldEditor value={value} onChange={onChange} fieldType={fieldType} />
  ),
  $time: ({ value, onChange }) => <TimeEditor value={value} onChange={onChange} />,
  $widgetProp: ({ value, onChange, schema, slot }) => (
    <WidgetPropEditor value={value} onChange={onChange} schema={schema} slot={slot} />
  ),
  $languages: () => <LanguagesEditor />,
  $stringExpr: ({ value, onChange, onOpenBindingPicker }) => (
    <StringExprEditor value={value} onChange={onChange} onOpenBindingPicker={onOpenBindingPicker} />
  ),
  $http: ({ value, onChange, onOpenBindingPicker }) => (
    <HttpEditor value={value} onChange={onChange} onOpenBindingPicker={onOpenBindingPicker} />
  ),
  $alarmCount: ({ value, onChange }) => <AlarmCountEditor value={value} onChange={onChange} />,
  $recipe: ({ value, onChange, fieldType }) => (
    <RecipeEditor value={value} onChange={onChange} fieldType={fieldType} />
  ),
  $recipeList: ({ value, onChange }) => <RecipeListEditor value={value} onChange={onChange} />,
  $componentProp: ({ value, onChange, schema, slot }) => (
    <ComponentPropEditor value={value} onChange={onChange} schema={schema} slot={slot} />
  ),
  $page: ({ value, onChange, fieldType }) => (
    <PageEditor value={value} onChange={onChange} fieldType={fieldType} />
  ),
  $viewport: ({ value, onChange, fieldType }) => (
    <ViewportEditor value={value} onChange={onChange} fieldType={fieldType} />
  ),
  $result: ({ value, onChange }) => <ResultEditor value={value} onChange={onChange} />,
  $repeatItem: ({ value, onChange, onOpenBindingPicker }) => (
    <RepeatItemEditor value={value} onChange={onChange} onOpenBindingPicker={onOpenBindingPicker} />
  ),
};

export default function PropertySourceEditor({
  value,
  onChange,
  source,
  staticEditor,
  onOpenBindingPicker,
  schema,
}: PropertySourceEditorProps) {
  const slot = useSlotType();
  const effectiveSource = source ?? 'static';
  const fieldType = slot === true ? undefined : slot ? slot.type : schema?.type;
  return (
    <>
      {SOURCE_EDITORS[effectiveSource]({
        value,
        onChange,
        schema,
        fieldType,
        slot,
        onOpenBindingPicker,
        staticEditor,
      })}
    </>
  );
}
