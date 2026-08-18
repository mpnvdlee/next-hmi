import { useMemo } from 'react';
import type { WidgetConfig, LayoutConfig } from '@shared/types/config';
import { widgetRegistry } from '@hmi/registry/widgetRegistry';
import PanelHeader from '../ui/PanelHeader';
import PropRow from '../ui/PropRow';
import SchemaFieldRow from '../ui/SchemaFieldRow';
import { LayoutFields } from '../ui/LayoutFields';
import { CONTAINER_DEFAULT_TOKENS } from '../ui/LayoutFields/containerDefaultTokens';
import WidgetIcon from '../ui/WidgetIcon';
import type { ComponentPropertySchema } from '@shared/types/componentProperty';
import { ComponentPropertySchemaContext } from '../editor/PropertySourceEditor/componentPropertySchemaContext';
import { parseTokenVar, usePanelTokenValues } from '@shared/utils/themeDefaultHint';
import { PanelScopeContext } from '@config/store/panelExpansionStore';
import { groupSchemaKeys } from '@config/utils/schemaGroups';

interface Props {
  comp: WidgetConfig;
  componentProperties: Record<string, ComponentPropertySchema>;
  onUpdate: (
    id: string,
    patch: { name?: string; properties?: Record<string, unknown>; layout?: Partial<LayoutConfig> },
  ) => void;
}

export default function CompositionWidgetPanel({ comp, componentProperties, onUpdate }: Props) {
  const entry = widgetRegistry[comp.type];
  const schema = entry?.schema ?? {};
  const schemaKeys = Object.keys(schema);
  const schemaGroups = groupSchemaKeys(schema);
  const isContainer = comp.type === 'Container';
  const layout = comp.layout ?? {};
  const props = comp.properties ?? {};

  // One getComputedStyle read for every themed default this panel's fields
  // (properties + layout) might show, instead of one per field.
  const tokenValues = usePanelTokenValues([
    ...schemaKeys.map((k) => parseTokenVar(schema[k].defaultValue)),
    ...(isContainer ? Object.values(CONTAINER_DEFAULT_TOKENS) : []),
  ]);

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
  );
}
