import { useMemo } from 'react';
import type { WidgetConfig, LayoutConfig } from '@shared/types/config';
import { widgetRegistry } from '@hmi/registry/widgetRegistry';
import PanelHeader from '../ui/PanelHeader';
import PropRow from '../ui/PropRow';
import SchemaFieldRow from '../ui/SchemaFieldRow';
import { LayoutFields } from '../ui/LayoutFields';
import { CONTAINER_DEFAULT_TOKENS } from '../ui/LayoutFields/containerDefaultTokens';
import { usesFlexLayout } from '@shared/utils/parentFlow';
import WidgetIcon from '../ui/WidgetIcon';
import type { ComponentPropertySchema } from '@shared/types/componentProperty';
import { ComponentPropertySchemaContext } from '../editor/PropertySourceEditor/componentPropertySchemaContext';
import RepeatEditorScopeProvider from '../editor/PropertySourceEditor/RepeatEditorScopeProvider';
import type { RepeatEditorScope } from '../editor/PropertySourceEditor/repeatScopeContext';
import { parseTokenVar, usePanelTokenValues } from '@shared/utils/themeDefaultHint';
import { PanelScopeContext } from '@config/store/panelExpansionStore';
import { groupSchemaKeys } from '@config/utils/schemaGroups';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { schemaFieldPicker } from '../editor/PropertySourceEditor/editors/utils';

/** A definition cannot see the Repeater an instance may be placed in, so its
 *  element's shape is unknown here; the backend skips the scope warning for the
 *  same reason. */
const DEFINITION_REPEAT_SCOPE: RepeatEditorScope = { members: null, writable: true };

interface Props {
  comp: WidgetConfig;
  /** The definition's widget tree, for finding a Repeater around `comp`. */
  definitionChildren?: WidgetConfig[];
  componentProperties: Record<string, ComponentPropertySchema>;
  onUpdate: (
    id: string,
    patch: { name?: string; properties?: Record<string, unknown>; layout?: Partial<LayoutConfig> },
  ) => void;
}

export default function CompositionWidgetPanel({
  comp,
  definitionChildren,
  componentProperties,
  onUpdate,
}: Props) {
  const entry = widgetRegistry[comp.type];
  const schema = entry?.schema ?? {};
  const schemaKeys = Object.keys(schema);
  const schemaGroups = groupSchemaKeys(schema);
  const isContainer = usesFlexLayout(comp.type);
  const layout = comp.layout ?? {};
  const props = comp.properties ?? {};

  // One getComputedStyle read for every themed default this panel's fields
  // (properties + layout) might show, instead of one per field.
  const tokenValues = usePanelTokenValues([
    ...schemaKeys.map((k) => parseTokenVar(schema[k].defaultValue)),
    ...(isContainer ? Object.values(CONTAINER_DEFAULT_TOKENS) : []),
  ]);

  const openBindingPicker = useEditorDomainStore((s) => s.openBindingPicker);

  function patchProp(key: string, value: unknown) {
    onUpdate(comp.id, { properties: { [key]: value } });
  }
  function patchLayout(patch: Partial<LayoutConfig>) {
    onUpdate(comp.id, { layout: patch });
  }
  function patchName(name: string) {
    onUpdate(comp.id, { name });
  }

  const componentPropertySchemaValue = useMemo(
    () => ({ properties: componentProperties, forbidVar: true }),
    [componentProperties],
  );

  return (
    <RepeatEditorScopeProvider
      roots={definitionChildren}
      fallback={DEFINITION_REPEAT_SCOPE}
      widgetId={comp.id}
    >
      <ComponentPropertySchemaContext.Provider value={componentPropertySchemaValue}>
        <PanelScopeContext.Provider value={comp.id}>
          <PanelHeader
            icon={<WidgetIcon type={comp.type} size={18} />}
            name={comp.name || (entry?.name ?? comp.type)}
            kind={entry?.name ?? comp.type}
          />

          <div className="cfg-section">
            <div className="cfg-section__title">Identity</div>
            <PropRow label="Name" sourceless>
              <input
                className="cfg-prop-input"
                type="text"
                value={comp.name}
                onChange={(e) => patchName(e.target.value)}
              />
            </PropRow>
          </div>

          {schemaGroups.map((group) => (
            <div className="cfg-section" key={group.title}>
              <div className="cfg-section__title">{group.title}</div>
              {group.keys.map((key) => (
                <SchemaFieldRow
                  key={key}
                  schema={schema[key]}
                  value={props[key]}
                  onChange={(v) => patchProp(key, v)}
                  onOpenPicker={schemaFieldPicker(openBindingPicker, schema[key], (binding) =>
                    patchProp(key, { $var: binding }),
                  )}
                  allProperties={props}
                  tokenValues={tokenValues}
                />
              ))}
            </div>
          ))}

          <div className="cfg-section">
            <div className="cfg-section__title">Layout</div>
            <LayoutFields
              mode={isContainer ? 'container' : 'leaf'}
              layout={layout}
              onChange={patchLayout}
              tokenValues={tokenValues}
            />
          </div>
        </PanelScopeContext.Provider>
      </ComponentPropertySchemaContext.Provider>
    </RepeatEditorScopeProvider>
  );
}
