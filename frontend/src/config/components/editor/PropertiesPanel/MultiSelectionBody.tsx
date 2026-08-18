import { useMemo, type ComponentType, type ReactNode } from 'react';
import { isContainerHostType, widgetRegistry } from '@hmi/registry/widgetRegistry';
import { SOURCE_CAPABLE_TYPES } from '@hmi/utils/propertySourceRules';
import type { LayoutConfig, WidgetConfig } from '@shared/types/config';
import type { RequiredFieldEntry } from '@shared/types/widgetSchema';
import { isStructType, primaryType } from '@shared/utils/valueTypes';
import { parseTokenVar, usePanelTokenValues } from '@shared/utils/themeDefaultHint';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { PanelScopeContext } from '@config/store/panelExpansionStore';
import { groupSchemaKeys } from '@config/utils/schemaGroups';
import { evaluateVisibility } from '@config/utils/visibilityEvaluator';
import PanelHeader from '../../ui/PanelHeader';
import SchemaFieldRow from '../../ui/SchemaFieldRow';
import WidgetIcon from '../../ui/WidgetIcon';
import { LayoutFields } from '../../ui/LayoutFields';
import { CONTAINER_DEFAULT_TOKENS } from '../../ui/LayoutFields/containerDefaultTokens';
import { commonSchemaOf } from './commonSchema';
import { mixedLayoutMap, multiValueOf } from './multiValue';

interface Props {
  /** Two or more widgets, in document order; the first is the lead. */
  comps: WidgetConfig[];
  onUpdate: (
    ids: string[],
    patch: { properties?: Record<string, unknown>; layout?: Partial<LayoutConfig> },
  ) => void;
  /** Wraps one schema group — the section chrome is all the two panels disagree
   *  on (collapsible in the page editor, a plain `cfg-section` in the component
   *  editor). */
  section: ComponentType<{ title: string; children: ReactNode }>;
  /** Offer the `$var` binding picker on sourced rows and layout values. Off in
   *  component authoring, where `$var` is forbidden. */
  bindingPicker?: boolean;
}

/**
 * The shared body of the two multi-selection property panels: the rows every
 * selected widget shares, with "Mixed" wherever they disagree, and one write that
 * lands on all of them.
 *
 * Kept as one component rather than two near-identical panels because the fan-out
 * rules — which rows are offered, and that *every* way of setting a row writes to
 * the whole selection — are the part that must not drift between the editors.
 */
export default function MultiSelectionBody({
  comps,
  onUpdate,
  section: Section,
  bindingPicker,
}: Props) {
  const openBindingPicker = useEditorDomainStore((s) => s.openBindingPicker);

  const ids = useMemo(() => comps.map((c) => c.id), [comps]);
  const { keys, schema } = useMemo(() => commonSchemaOf(comps), [comps]);
  const schemaGroups = useMemo(() => groupSchemaKeys(schema), [schema]);
  const mixedLayout = useMemo(() => mixedLayoutMap(comps), [comps]);
  // The smaller field set unless every selection is a container — offering
  // container-only layout rows for a leaf would write properties it cannot use.
  const allContainers = comps.every((c) => isContainerHostType(c.type));
  const leadLayout = comps[0].layout ?? {};

  const tokenValues = usePanelTokenValues([
    ...keys.map((k) => parseTokenVar(schema[k].defaultValue)),
    ...keys.map((k) => schema[k].defaultToken),
    ...(allContainers ? Object.values(CONTAINER_DEFAULT_TOKENS) : []),
  ]);

  function patchProp(key: string, value: unknown) {
    onUpdate(ids, { properties: { [key]: value } });
  }
  function patchLayout(patch: Partial<LayoutConfig>) {
    onUpdate(ids, { layout: patch });
  }

  /** A row is offered only where every selected widget would show it — you cannot
   *  set a property a widget currently ignores. */
  const visibleEverywhere = (key: string): boolean =>
    comps.every((comp) => evaluateVisibility(schema[key].visibleWhen, comp.properties ?? {}));

  const renderSchemaRow = (key: string) => {
    const field = schema[key];
    const value = multiValueOf(comps, key);
    const fieldType = primaryType(field.type).toLowerCase();
    // The same test `SchemaFieldRow` draws the row with (`isStructType` for a
    // struct row, `SOURCE_CAPABLE_TYPES` for a sourced one). A literal `'struct'`
    // here would leave a named struct — `Alarms[]`, a custom widget's declared
    // type — rendered as a binding row whose `✎` is missing under multi-selection
    // but present under single.
    const sourced = isStructType(fieldType) || SOURCE_CAPABLE_TYPES.has(fieldType);
    return (
      <SchemaFieldRow
        key={key}
        schema={field}
        value={value.state === 'same' ? value.value : undefined}
        mixed={value.state === 'mixed' ? { source: value.source } : undefined}
        onChange={(v) => patchProp(key, v)}
        // The row re-checks `visibleWhen` itself against these. The lead's
        // properties are a safe stand-in: `visibleEverywhere` has already
        // established that every selected widget satisfies the condition.
        allProperties={comps[0].properties ?? {}}
        onOpenPicker={
          bindingPicker && sourced
            ? // The lead's id scopes the picker's "what is bound today" preselect
              // only. A nested slot (an `$if` branch, a `$switch` case) passes its
              // own writer; the row-level `✎` passes none, and the picker's own
              // fallback writes to that one lead id — so it gets a writer that
              // fans out, landing a picked (or cleared) binding wherever a typed
              // edit would.
              (onPick, currentBinding) =>
                openBindingPicker(comps[0].id, key, {
                  onPick: onPick ?? ((binding) => patchProp(key, { $var: binding })),
                  currentBinding,
                  filter: {
                    label: field.label,
                    type: field.type,
                    write: (field as { write?: boolean }).write,
                    requiredFields: (field as { requiredFields?: RequiredFieldEntry[] })
                      .requiredFields,
                  },
                })
            : undefined
        }
        tokenValues={tokenValues}
      />
    );
  };

  const kinds = new Set(comps.map((c) => widgetRegistry[c.type]?.name ?? c.type));

  return (
    // A synthetic scope id: panel expand state persists while the same set stays
    // selected, and can never collide with a real widget id. Field diagnostics are
    // per-widget with no sensible merge, so a multi row deliberately shows none.
    <PanelScopeContext.Provider value={`multi:${[...ids].sort().join(',')}`}>
      <PanelHeader
        icon={<WidgetIcon type={comps[0].type} size={18} />}
        name={`${comps.length} components`}
        kind={kinds.size === 1 ? [...kinds][0] : 'Mixed types'}
      />

      {schemaGroups.map((group) => {
        const groupKeys = group.keys.filter(visibleEverywhere);
        if (groupKeys.length === 0) return null;
        return (
          <Section key={group.title} title={group.title}>
            {groupKeys.map(renderSchemaRow)}
          </Section>
        );
      })}

      <Section title="Layout">
        <LayoutFields
          mode={allContainers ? 'container' : 'leaf'}
          layout={leadLayout}
          onChange={patchLayout}
          // The lead's id only scopes the picker's "what is bound today"
          // preselect, exactly as the schema rows above use it; the pick itself
          // writes through `onChange`, so it lands on every selected widget.
          componentId={bindingPicker ? comps[0].id : undefined}
          mixedLayout={mixedLayout}
          tokenValues={tokenValues}
        />
      </Section>
    </PanelScopeContext.Provider>
  );
}
