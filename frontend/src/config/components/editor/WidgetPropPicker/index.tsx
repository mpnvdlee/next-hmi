/**
 * WidgetPropPicker — overlay for picking a $widgetProp target.
 *
 * Tree of components → exported properties → struct fields. A `Struct`-typed
 * export expands to its candidate fields so a single field can be bound;
 * selecting the property itself binds the whole struct. Struct fields carry
 * datatypes when the component declares a
 * `structSchema` on the export (otherwise they fall back to the configured
 * column keys, untyped).
 *
 * The property/field levels of the tree are the same shape as
 * VariableBindingPicker's component-prop mode (a top-level property record,
 * each optionally expanding into a StructSchemaNode tree), so this picker
 * adapts its own model (ComponentOption → ExportedProperty → ExportedStructField)
 * into that shape and reuses its row-building, row chrome and RightPanel
 * wholesale. The one genuinely distinct concern is the outer "component"
 * grouping, which VariableBindingPicker's component-prop mode doesn't have.
 */

import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import type { CSSProperties } from 'react';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { useToggleSet } from '@shared/hooks/useToggleSet';
import { treePaddingLeft } from '@config/utils/treeRowLayout';
import BindingPickerShell from '../BindingPickerShell';
import { GroupHeaderRow } from '../BindingPickerShell/rowParts';
import { PickerRow, type RowContext } from '../VariableBindingPicker/rows';
import {
  buildComponentPropRows,
  isCompatible,
  isCompatibleLeafNode,
  isStructTarget,
} from '../VariableBindingPicker/componentPropHelpers';
import type { RowItem } from '../VariableBindingPicker/variableTreeHelpers';
import RightPanel, {
  type ComponentPropMode,
  type ComponentPropSelectedItem,
} from '../VariableBindingPicker/RightPanel';
import type { ComponentOption } from '../WidgetOptionsContext';
import type { ExportedProperty, ExportedStructField } from '@shared/types/widgetSchema';
import type { ComponentPropertySchema, StructSchemaNode } from '@shared/types/componentProperty';
import { rfName, type RequiredFieldEntry } from '../bindingPickerUtils';
import { matchesSearchWords } from '@shared/utils/search';
import { COMPOSITE_KEY_SEP, parseWidgetPropRowKey as parseRowKey } from './rowKey';

const NO_LOADING = new Set<string>();

type PropOrFieldRow = Extract<RowItem, { kind: 'component-prop' | 'component-prop-node' }>;
type WidgetPropRow =
  { kind: 'group'; comp: ComponentOption; key: string; depth: number } | PropOrFieldRow;

/**
 * Struct fields offered for an exported property: declared typed fields first,
 * then any configured column keys not already declared (untyped). Empty for a
 * scalar export.
 */
function structFieldsFor(comp: ComponentOption, prop: ExportedProperty): ExportedStructField[] {
  if (prop.type !== 'Struct') return [];
  const declared = prop.structSchema ?? [];
  const declaredNames = new Set(declared.map((f) => f.name));
  const derived = (comp.structFields ?? [])
    .filter((n) => !declaredNames.has(n))
    .map((n) => ({ name: n }));
  return [...declared, ...derived];
}

/**
 * Adapt an exported property to the ComponentPropertySchema shape the shared
 * compatibility/row-building helpers understand. `isCompatible` / `isCompatibleLeafNode`
 * only read `type`/`write` on `variable` nodes and never descend into `children`, so
 * flattening the declared fields to childless variable nodes is a safe adapter.
 */
function adaptSchema(
  prop: ExportedProperty,
  fields: ExportedStructField[],
): ComponentPropertySchema {
  return {
    type: prop.type ?? 'string',
    label: prop.label,
    structSchema: fields.length
      ? fields.map((f) => ({
          kind: 'variable' as const,
          name: f.name,
          type: f.type,
          write: f.write,
        }))
      : undefined,
  };
}

/**
 * Build the row list: one shared `buildComponentPropRows` call per component
 * (namespaced by component id so keys stay unique across components), wrapped
 * in a "group" header row when the component has at least one qualifying
 * property. A component whose own name/id matches the search bypasses the
 * per-property search gate (all of its type-compatible properties show) —
 * the same "gate the row, don't prune its children" choice buildComponentPropRows
 * documents for the property/field levels, applied one level up.
 */
function buildWidgetPropRows(
  components: ComponentOption[],
  fieldType: string | string[] | undefined,
  requiredFields: RequiredFieldEntry[] | undefined,
  search: string,
  showAll: boolean,
  collapsed: Set<string>,
): WidgetPropRow[] {
  const rows: WidgetPropRow[] = [];

  for (const comp of components) {
    if (!comp.exportedProperties.length) continue;
    const compLabel = comp.name || comp.type;
    const componentSearchPath = `${compLabel} ${comp.id} ${comp.type}`;
    const matchesComp = matchesSearchWords(search, componentSearchPath);

    const properties: Record<string, ComponentPropertySchema> = {};
    for (const prop of comp.exportedProperties) {
      properties[prop.key] = adaptSchema(prop, structFieldsFor(comp, prop));
    }

    const propRows = buildComponentPropRows(
      properties,
      fieldType,
      requiredFields,
      matchesComp ? '' : search,
      showAll,
      collapsed,
      {
        keyPrefix: `${comp.id}${COMPOSITE_KEY_SEP}`,
        baseDepth: 1,
        searchPath: componentSearchPath,
      },
    ) as PropOrFieldRow[];

    if (propRows.length === 0) continue;

    const groupKey = `comp:${comp.id}`;
    rows.push({ kind: 'group', comp, key: groupKey, depth: 0 });
    if (!collapsed.has(groupKey)) rows.push(...propRows);
  }
  return rows;
}

function rowReactKey(row: PropOrFieldRow): string {
  return row.kind === 'component-prop' ? row.key : row.itemKey;
}

export default function WidgetPropPicker() {
  const open = useEditorDomainStore((s) => s.widgetPropPickerOpen);
  const target = useEditorDomainStore((s) => s.widgetPropPickerTarget);
  const close = useEditorDomainStore((s) => s.closeWidgetPropPicker);

  const [search, setSearch] = useState('');
  const [collapsed, toggle, setCollapsed] = useToggleSet<string>();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const currentKey = target?.currentKey;

  useEffect(() => {
    if (open) {
      setSearch('');
      setSelectedKey(currentKey ?? null);
      setShowAll(false);
      setCollapsed(new Set());
    }
    // currentKey is captured at open time only — it must not re-select while
    // the user browses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, setCollapsed]);

  // The list isn't virtualized, so the preselected row exists in the DOM as
  // soon as it renders — bring it into view rather than highlighting it off
  // screen under a component further down.
  useEffect(() => {
    if (!open || !currentKey) return;
    const row = listRef.current?.querySelector('.editor-binding-item--selected');
    row?.scrollIntoView({ block: 'center' });
  }, [open, currentKey]);

  const pickAndClose = useCallback(
    (key: string) => {
      const sel = parseRowKey(key);
      if (!sel || !target) return;
      target.onPick(sel.componentId, sel.property, sel.path);
      close();
    },
    [target, close],
  );

  const handleConfirm = useCallback(() => {
    if (!selectedKey) return;
    pickAndClose(selectedKey);
  }, [selectedKey, pickAndClose]);

  const handleClear = useCallback(() => {
    if (!target?.onClear) return;
    target.onClear();
    close();
  }, [target, close]);

  function selectKey(key: string) {
    setSelectedKey(key);
  }

  if (!open || !target) return null;

  const { fieldType, requiredFields } = target;
  const title = target.label;

  const rows = buildWidgetPropRows(
    target.componentOptions,
    fieldType,
    requiredFields,
    search,
    showAll,
    collapsed,
  );

  // ── Right panel (shared with VariableBindingPicker's component-prop mode) ──
  const sel = selectedKey ? parseRowKey(selectedKey) : null;
  const selComp = sel
    ? (target.componentOptions.find((c) => c.id === sel.componentId) ?? null)
    : null;
  const selProp =
    selComp && sel
      ? (selComp.exportedProperties.find((p) => p.key === sel.property) ?? null)
      : null;

  const requiredNamesSet = requiredFields?.length ? new Set(requiredFields.map(rfName)) : undefined;
  const isStructTargetVal = fieldType !== undefined && isStructTarget(fieldType);

  let selectedItem: ComponentPropSelectedItem | null = null;
  let typeIsOk: boolean | null = null;

  if (selComp && selProp && sel) {
    const fields = structFieldsFor(selComp, selProp);
    const schema = adaptSchema(selProp, fields);
    const compLabel = selComp.name || selComp.type;
    let node: StructSchemaNode | null = null;
    let displayLabel: ReactNode;
    if (sel.path) {
      const field = fields.find((f) => f.name === sel.path);
      node = {
        kind: 'variable',
        name: field?.name ?? sel.path,
        type: field?.type,
        write: field?.write,
      };
      if (fieldType !== undefined) typeIsOk = isCompatibleLeafNode(node, fieldType);
      displayLabel = (
        <>
          <span className="cfg-component-prop-path__prefix">
            {compLabel} › {selProp.label} ›{' '}
          </span>
          <strong>{node.name}</strong>
        </>
      );
    } else {
      if (fieldType !== undefined) typeIsOk = isCompatible(schema, fieldType, requiredFields);
      displayLabel = (
        <>
          <span className="cfg-component-prop-path__prefix">{compLabel} › </span>
          <strong>{selProp.label}</strong>
        </>
      );
    }
    selectedItem = {
      propKey: sel.property,
      propSchema: schema,
      node,
      structNodes: sel.path ? null : (schema.structSchema ?? null),
      displayLabel,
    };
  }

  const componentPropMode: ComponentPropMode = {
    fieldType,
    requiredFields,
    requiredNamesSet,
    isStructTarget: isStructTargetVal,
    typeIsOk,
    selectedItem,
  };

  const listContent = (
    <>
      {rows.length === 0 && (
        <p className="editor-binding-empty">
          {target.componentOptions.length === 0
            ? 'No components with exported properties on this page.'
            : 'No matches.'}
        </p>
      )}
      {rows.map((row) => {
        if (row.kind === 'group') {
          return (
            <GroupHeaderRow
              key={`c-${row.comp.id}`}
              rowStyle={
                {
                  '--row-indent': treePaddingLeft(row.depth, { stepRem: 1, baseRem: 1 }),
                } as CSSProperties
              }
              isOpen={!collapsed.has(row.key)}
              name={row.comp.name || row.comp.type}
              meta={row.comp.id}
              metaTruncate
              onToggle={() => toggle(row.key)}
            />
          );
        }
        const ctx: RowContext = {
          rowStyle: {
            '--row-indent': treePaddingLeft(row.depth, { stepRem: 1, baseRem: 1 }),
          } as CSSProperties,
          selectedKey,
          collapsed,
          toggleCollapsed: toggle,
          selectKey,
          onPickAndClose: pickAndClose,
          dsLoading: NO_LOADING,
        };
        return <PickerRow key={rowReactKey(row)} item={row} ctx={ctx} />;
      })}
    </>
  );

  return (
    <BindingPickerShell
      title={title ?? 'Property'}
      action="Select property"
      onClose={close}
      onConfirm={handleConfirm}
      onClear={target.onClear ? handleClear : undefined}
      confirmDisabled={!selectedKey}
      search={search}
      onSearchChange={setSearch}
      searchPlaceholder="Search components, properties or fields…"
      showAllCheckbox={fieldType !== undefined}
      showAll={showAll}
      onShowAllChange={setShowAll}
      listRef={listRef}
      listContent={listContent}
      rightPanel={
        <RightPanel
          pickerTitle={title ?? 'Property'}
          selectedKey={selectedKey}
          varMode={null}
          componentPropMode={componentPropMode}
        />
      }
    />
  );
}
