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
  ResultEditor,
  TimeEditor,
  UrlParamEditor,
  UserFieldEditor,
  UserGroupsEditor,
  VarEditor,
  ViewportEditor,
} from './editors/leaf';
import { CompareEditor, IfEditor, SwitchEditor } from './editors/conditional';
import { WidgetPropEditor, ComponentPropEditor } from './editors/picker';
import { StringExprEditor } from './editors/stringExpr';
import { HttpEditor } from './editors/http';
import type { OpenBindingPicker } from './editors/utils';

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
  $random: ({ value, onChange }) => <RandomEditor value={value} onChange={onChange} />,
  $switch: ({ value, onChange, schema, onOpenBindingPicker }) => (
    <SwitchEditor
      value={value}
      onChange={onChange}
      schema={schema}
      onOpenBindingPicker={onOpenBindingPicker}
    />
  ),
  $user: ({ value, onChange }) => <UserFieldEditor value={value} onChange={onChange} />,
  $userGroups: ({ value, onChange }) => <UserGroupsEditor value={value} onChange={onChange} />,
  $device: ({ value, onChange }) => <DeviceFieldEditor value={value} onChange={onChange} />,
  $time: ({ value, onChange }) => <TimeEditor value={value} onChange={onChange} />,
  $widgetProp: ({ value, onChange, schema }) => (
    <WidgetPropEditor value={value} onChange={onChange} schema={schema} />
  ),
  $languages: () => <LanguagesEditor />,
  $stringExpr: ({ value, onChange, onOpenBindingPicker }) => (
    <StringExprEditor value={value} onChange={onChange} onOpenBindingPicker={onOpenBindingPicker} />
  ),
  $http: ({ value, onChange, onOpenBindingPicker }) => (
    <HttpEditor value={value} onChange={onChange} onOpenBindingPicker={onOpenBindingPicker} />
  ),
  $alarmCount: ({ value, onChange }) => <AlarmCountEditor value={value} onChange={onChange} />,
  $recipe: ({ value, onChange }) => <RecipeEditor value={value} onChange={onChange} />,
  $recipeList: ({ value, onChange }) => <RecipeListEditor value={value} onChange={onChange} />,
  $componentProp: ({ value, onChange, schema }) => (
    <ComponentPropEditor value={value} onChange={onChange} schema={schema} />
  ),
  $page: ({ value, onChange }) => <PageEditor value={value} onChange={onChange} />,
  $viewport: ({ value, onChange }) => <ViewportEditor value={value} onChange={onChange} />,
  $result: ({ value, onChange }) => <ResultEditor value={value} onChange={onChange} />,
};

export default function PropertySourceEditor({
  value,
  onChange,
  source,
  staticEditor,
  onOpenBindingPicker,
  schema,
}: PropertySourceEditorProps) {
  const effectiveSource = source ?? 'static';
  return (
    <>
      {SOURCE_EDITORS[effectiveSource]({
        value,
        onChange,
        schema,
        onOpenBindingPicker,
        staticEditor,
      })}
    </>
  );
}
