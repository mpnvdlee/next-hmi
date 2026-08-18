/**
 * VariableBindingPicker — full-screen overlay.
 *
 * Opens when a "Change…" button is clicked in the Properties Panel.
 * Operates in two modes:
 *
 *  - Variable mode (default): fetches all datasources and their variables,
 *    shows them grouped by datasource in a tree, lets the user select a
 *    variable to bind. Produces bindings: { source, datasource, path }.
 *
 *  - Component-prop mode (when target.componentPropSource is set): shows the surrounding
 *    widget or dialog's declared input properties as the selectable tree
 *    instead of fetching datasources. Produces a string property key.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import type { CSSProperties } from 'react';
import BindingPickerShell from '../BindingPickerShell';
import { SearchHighlightProvider } from '@config/components/ui/SearchHighlight';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { useConfigStore } from '@shared/store/configStore';
import VirtualTreeRows from '@config/components/shared/VirtualTreeRows';
import { PickerRow, type RowContext } from './rows';
import {
  filterTree,
  parseApiTree,
  type PickerTreeNode,
  type PickerVariableEntry,
} from '@config/components/ui/datasourceTreeHelpers';
import { accepts, elementOf, nodeVarType, parseTypeToken } from '@shared/types/varType';
import { acceptedValueTypes, isStructType, primaryType } from '@shared/utils/valueTypes';
import { useToggleSet } from '@shared/hooks/useToggleSet';
import { treePaddingLeft } from '@config/utils/treeRowLayout';
import { widgetRegistry } from '@hmi/registry/widgetRegistry';
import { useVariableStore } from '@hmi/store/variableStore';
import type { VariableBinding } from '@shared/types/config';
import type { DatasourceListItem } from '@shared/types/datasource';
import { parseVarKey } from '@shared/types/datasource';
import { isArrayShape } from '@shared/types/arrayShape';
import { findComponentInPages } from '@shared/utils/widgetTree';
import { apiJson } from '@shared/utils/api';
import { withDotSearchSeparators } from '@shared/utils/search';
import type { StructSchemaNode } from '@shared/types/componentProperty';
import { rfName } from '../bindingPickerUtils';
import {
  type DatasourceNode,
  type RowItem,
  flattenAll,
  flattenForRender,
  annotateSelectable,
  typeFilter,
  findRawFolder,
  collectFolderKeys,
  resolveElementBinding,
  rowSelectionKey,
} from './variableTreeHelpers';
import {
  buildComponentPropRows,
  isCompatible,
  isCompatibleFolderNode,
  isCompatibleLeafNode,
} from './componentPropHelpers';
import { ComponentPropPath } from './ComponentPropPath';
import RightPanel, { type ComponentPropMode, type VarMode } from './RightPanel';

type TreeNode = PickerTreeNode;
type VariableEntry = PickerVariableEntry;

/** Collapse key for the component-prop mode's single source row. Namespaced so it
 *  can never collide with a property key. */
const COMPONENT_PROP_SOURCE_KEY = 'source:componentProps';

// ── Component ─────────────────────────────────────────────────────────────────

export default function VariableBindingPicker() {
  const open = useEditorDomainStore((s) => s.bindingPickerOpen);
  const target = useEditorDomainStore((s) => s.bindingPickerTarget);
  const closeBindingPicker = useEditorDomainStore((s) => s.closeBindingPicker);

  const pages = useConfigStore((s) => s.pages);
  const updateComponent = useConfigStore((s) => s.updateComponent);

  // Tree of DatasourceNode[] — each datasource is a top-level collapsible node
  const [dsTree, setDsTree] = useState<DatasourceNode[]>([]);
  const [dsLoaded, setDsLoaded] = useState<Set<string>>(new Set());
  const [dsLoading, setDsLoading] = useState<Set<string>>(new Set());
  const [dsFailed, setDsFailed] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [collapsed, toggle, setCollapsed] = useToggleSet<string>();
  const [loadError, setLoadError] = useState<string | null>(null);
  const seenDatasources = useRef<Set<string>>(new Set());
  const headersControllerRef = useRef<AbortController | null>(null);
  const datasourceControllersRef = useRef<Map<string, AbortController>>(new Map());
  const scrolledToSelection = useRef(false);

  // Selected composite key
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const isComponentPropMode = !!target?.componentPropSource;

  // Find the target component and its current binding (var mode only)
  const comp = useMemo(
    () => (!isComponentPropMode && target ? findComponentInPages(pages, target.componentId) : null),
    [isComponentPropMode, target, pages],
  );

  const currentKey = useMemo<string | null>(() => {
    if (isComponentPropMode || !target) return null;
    // A component property reads back off the page tree; `currentBinding` also
    // covers callers whose value hangs off the component elsewhere (shell
    // regions, `layout.*`), so it stays the fallback even when `comp` resolves.
    const val = comp?.properties?.[target.propertyKey];
    const wrapped: VariableBinding | undefined =
      (val && typeof val === 'object' && '$var' in (val as Record<string, unknown>)
        ? (val as { $var?: VariableBinding }).$var
        : undefined) ?? target.currentBinding;
    if (!wrapped?.path) return null;
    const base = wrapped.path;
    if (wrapped.index === undefined) return base;
    // struct[] elements are addressed by folder path (".../[N]"), scalar
    // arrays by a bracket suffix on the variable's own path (§10.5) —
    // mirrors the encodings handleConfirm produces below.
    const baseType = useVariableStore.getState().varMeta[base]?.type;
    const isStructArray = baseType?.kind === 'struct' && baseType.array;
    return isStructArray ? `${base}/[${wrapped.index}]` : `${base}[${wrapped.index}]`;
  }, [isComponentPropMode, comp, target]);

  // Reset shared state on open
  useEffect(() => {
    if (!open) return;
    setSearch('');
    setShowAll(false);
    setLoadError(null);
    setDsFailed(new Set());
    prevSearch.current = '';
    scrolledToSelection.current = false;
    if (isComponentPropMode && target?.componentPropSource) {
      const boundKey = target.componentPropSource.currentKey || null;
      setSelectedKey(boundKey);
      // Pre-collapse all struct properties so the tree starts at a clean state —
      // except the ones the current selection sits under, which stay open so the
      // bound row is visible (and scroll-to-selection can find it).
      const structKeys = Object.entries(target.componentPropSource.properties)
        .filter(([, s]) => isStructType(primaryType(s.type)) && s.structSchema?.length)
        .map(([k]) => k)
        .filter((k) => !(boundKey === k || boundKey?.startsWith(`${k}/`)));
      setCollapsed(new Set(structKeys));
    } else {
      setSelectedKey(currentKey);
    }
    // currentKey is intentionally excluded — we only want to capture it at open time
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isComponentPropMode]);

  // Cleanup abort controllers on close
  useEffect(() => {
    if (open) return;
    headersControllerRef.current?.abort();
    headersControllerRef.current = null;
    datasourceControllersRef.current.forEach((controller) => controller.abort());
    datasourceControllersRef.current.clear();
    setDsLoading(new Set());
  }, [open]);

  useEffect(() => {
    const datasourceControllers = datasourceControllersRef.current;
    return () => {
      headersControllerRef.current?.abort();
      datasourceControllers.forEach((controller) => controller.abort());
      datasourceControllers.clear();
    };
  }, []);

  // Schema field derived from filter/registry (var mode only)
  const schemaField = useMemo(() => {
    if (isComponentPropMode || !target) return null;
    if (target.filter) return target.filter;
    if (!comp) return null;
    return widgetRegistry[comp.type]?.schema[target.propertyKey] ?? null;
  }, [isComponentPropMode, comp, target]);

  const includeDisabled = target?.filter?.includeDisabled === true;

  // ── Var mode: Phase 1 — load datasource headers on open ──────────────────

  useEffect(() => {
    if (!open || isComponentPropMode) return;
    headersControllerRef.current?.abort();
    const controller = new AbortController();
    headersControllerRef.current = controller;

    (async () => {
      try {
        const list = (
          await apiJson<DatasourceListItem[]>('/api/datasources', { signal: controller.signal })
        ).filter((ds) => ds.type !== 'opcua-test-server');
        if (headersControllerRef.current !== controller) return;

        const nodes: DatasourceNode[] = list.map((ds) => ({
          kind: 'datasource',
          name: ds.name,
          type: ds.type,
          children: [],
        }));
        setDsTree((prev) =>
          nodes.map((n) => {
            const existing = prev.find((p) => p.name === n.name);
            return existing ? { ...n, children: existing.children } : n;
          }),
        );
        // Seed only datasources never seen before, and merge rather than
        // replace: an expansion that already landed must survive this.
        const unseen = nodes.filter((n) => !seenDatasources.current.has(n.name));
        if (unseen.length) {
          setCollapsed((prev) => new Set([...prev, ...unseen.map((n) => `ds:${n.name}`)]));
          for (const n of unseen) seenDatasources.current.add(n.name);
        }
        setLoadError(null);
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error('[VariableBindingPicker] Failed to load datasource list:', err);
        setDsTree([]);
        setLoadError('Could not load datasources.');
      } finally {
        if (headersControllerRef.current === controller) {
          headersControllerRef.current = null;
        }
      }
    })();
  }, [open, isComponentPropMode, setCollapsed]);

  // ── Var mode: Phase 2 — load variables for a specific datasource ──────────

  const loadDatasource = useCallback(
    async (name: string) => {
      const existing = datasourceControllersRef.current.get(name);
      existing?.abort();
      const controller = new AbortController();
      datasourceControllersRef.current.set(name, controller);

      setDsLoading((prev) => new Set([...prev, name]));
      try {
        const { variables } = await apiJson<{ variables: unknown[] }>(
          `/api/datasources/${encodeURIComponent(name)}/variables`,
          { signal: controller.signal },
        );
        if (datasourceControllersRef.current.get(name) !== controller) return;

        const children = Array.isArray(variables) ? parseApiTree(variables, name) : [];
        const subFolderKeys = collectFolderKeys(children);
        setCollapsed((prev) => new Set([...prev, ...subFolderKeys]));
        setDsTree((prev): DatasourceNode[] =>
          prev.some((ds) => ds.name === name)
            ? prev.map((ds) => (ds.name === name ? { ...ds, children } : ds))
            : [...prev, { kind: 'datasource', name, type: '', children }],
        );
        setDsLoaded((prev) => new Set([...prev, name]));
        setLoadError(null);
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error(`[VariableBindingPicker] Failed to load datasource "${name}":`, err);
        // Remembered so the expand-driven loader below cannot retry in a loop.
        setDsFailed((prev) => new Set([...prev, name]));
        setLoadError(`Could not load variables for datasource "${name}".`);
      } finally {
        if (datasourceControllersRef.current.get(name) === controller) {
          datasourceControllersRef.current.delete(name);
        }
        setDsLoading((prev) => {
          const s = new Set(prev);
          s.delete(name);
          return s;
        });
      }
    },
    [setCollapsed],
  );

  // ── Var mode: load every datasource that is rendered expanded ─────────────

  // Loading is driven by rendered state rather than by the event that caused
  // the expansion, so no ordering between the header fetch, the auto-expand
  // below and a user click can leave a datasource expanded-but-empty.
  useEffect(() => {
    if (!open || isComponentPropMode) return;
    for (const ds of dsTree) {
      if (collapsed.has(`ds:${ds.name}`)) continue;
      if (dsLoaded.has(ds.name) || dsLoading.has(ds.name) || dsFailed.has(ds.name)) continue;
      loadDatasource(ds.name);
    }
  }, [open, isComponentPropMode, dsTree, collapsed, dsLoaded, dsLoading, dsFailed, loadDatasource]);

  // ── Var mode: auto-expand to current binding ──────────────────────────────

  // Re-runs as `dsTree` grows (headers, then the loaded variable tree), so the
  // folder keys `loadDatasource` collapses on arrival get opened again.
  useEffect(() => {
    if (!open || !currentKey) return;
    const { datasource } = parseVarKey(currentKey);
    if (!datasource) return;
    if (!dsTree.some((ds) => ds.name === datasource)) return;
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.delete(`ds:${datasource}`);
      const segments = currentKey.slice(datasource.length + 1).split('/');
      for (let i = 1; i < segments.length; i++) {
        next.delete(`${datasource}:${segments.slice(0, i).join('/')}`);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [open, currentKey, dsTree, setCollapsed]);

  // ── Var mode: search triggers loading all unloaded datasources ────────────

  const prevSearch = useRef('');
  useEffect(() => {
    if (isComponentPropMode) return;
    const wasEmpty = prevSearch.current.trim() === '';
    const isNowActive = search.trim() !== '';
    prevSearch.current = search;
    if (!isNowActive || !wasEmpty) return;
    for (const ds of dsTree) {
      if (!dsLoaded.has(ds.name) && !dsLoading.has(ds.name) && !dsFailed.has(ds.name)) {
        loadDatasource(ds.name);
      }
    }
  }, [isComponentPropMode, search, dsTree, dsLoaded, dsLoading, dsFailed, loadDatasource]);

  // ── Build row list ────────────────────────────────────────────────────────

  // Type-filtered / annotated tree — independent of search so the expensive
  // tree clone doesn't re-run on every keystroke.
  const typedDsTree = useMemo((): DatasourceNode[] => {
    if (isComponentPropMode) return [];
    return dsTree.map((ds) => ({
      ...ds,
      children: showAll
        ? annotateSelectable(ds.children, schemaField)
        : typeFilter(ds.children, schemaField, includeDisabled),
    }));
  }, [isComponentPropMode, dsTree, schemaField, includeDisabled, showAll]);

  const rows = useMemo((): RowItem[] => {
    if (isComponentPropMode && target?.componentPropSource) {
      const { properties, fieldType, requiredFields } = target.componentPropSource;
      const propRows = buildComponentPropRows(
        properties,
        fieldType,
        requiredFields,
        search,
        showAll,
        collapsed,
        { baseDepth: 1 },
      );
      if (propRows.length === 0) return propRows;
      const source: RowItem = {
        kind: 'component-prop-source',
        key: COMPONENT_PROP_SOURCE_KEY,
        name: 'Component properties',
        depth: 0,
      };
      return collapsed.has(COMPONENT_PROP_SOURCE_KEY) ? [source] : [source, ...propRows];
    }
    // Var mode
    const filtered: DatasourceNode[] = search.trim()
      ? typedDsTree
          .map((ds) => ({
            ...ds,
            children: filterTree(ds.children, search, `${ds.name} ${ds.type}`) as TreeNode[],
          }))
          .filter((ds) => ds.children.length > 0)
      : typedDsTree;
    // Search results must expose their matching descendants even when their
    // datasource/folder was previously collapsed.
    return flattenForRender(filtered, 0, search.trim() ? new Set() : collapsed);
  }, [isComponentPropMode, target, typedDsTree, search, showAll, collapsed]);

  // All variable entries across all datasources (for var-mode right panel lookup)
  const allVars = useMemo(() => {
    if (isComponentPropMode) return [];
    const out: VariableEntry[] = [];
    for (const ds of dsTree) {
      out.push(...flattenAll(ds.children, ds.name));
    }
    return out;
  }, [isComponentPropMode, dsTree]);

  // Raw (unfiltered) folder for the selected binding — var mode right panel
  const rawSelectedFolder = useMemo(
    () => (!isComponentPropMode && selectedKey ? findRawFolder(dsTree, selectedKey) : null),
    [isComponentPropMode, dsTree, selectedKey],
  );

  // Resolved selection for component-prop mode (top-level prop or nested struct node)
  const componentPropSelectedItem = useMemo(() => {
    if (!isComponentPropMode || !selectedKey || !target?.componentPropSource) return null;
    const { properties } = target.componentPropSource;
    const slashIdx = selectedKey.indexOf('/');
    if (slashIdx === -1) {
      const schema = properties[selectedKey];
      return schema
        ? {
            propKey: selectedKey,
            propSchema: schema,
            node: null as StructSchemaNode | null,
            structNodes: schema.structSchema ?? null,
            displayLabel: <ComponentPropPath value={selectedKey} properties={properties} />,
          }
        : null;
    }
    const propKey = selectedKey.slice(0, slashIdx);
    const subPath = selectedKey.slice(slashIdx + 1);
    const propSchema = properties[propKey];
    if (!propSchema) return null;
    let nodes = propSchema.structSchema ?? [];
    let node: StructSchemaNode | null = null;
    for (const part of subPath.split('/')) {
      node = nodes.find((n) => n.name === part) ?? null;
      if (!node) return null;
      nodes = node.children ?? [];
    }
    return node
      ? {
          propKey,
          propSchema,
          node,
          structNodes: node.children ?? null,
          displayLabel: <ComponentPropPath value={selectedKey} properties={properties} />,
        }
      : null;
  }, [isComponentPropMode, target, selectedKey]);

  // Scroll container for the virtual list
  const listRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 26,
    overscan: 10,
  });

  // Scroll the current binding into view on open. The row is selected and
  // rendered as soon as the tree expands to it, but a deep binding starts below
  // the fold. A single scroll is unreliable: on the fast (cached) path the row
  // appears before the virtualizer's ResizeObserver has measured the scroll
  // container, so scrollToIndex computes against a zero height and lands wrong.
  // Retry across frames until the target row is actually within the rendered
  // range (or we run out of attempts). Re-runs while the tree is still settling
  // (rows changes); the ref makes it a one-shot so it never fights the user.
  const openSelectionKey = isComponentPropMode
    ? (target?.componentPropSource?.currentKey ?? null)
    : currentKey;
  useEffect(() => {
    if (!open || scrolledToSelection.current || !openSelectionKey) return;
    const idx = rows.findIndex((r) => rowSelectionKey(r) === openSelectionKey);
    if (idx < 0) return;
    let raf = 0;
    let attempts = 0;
    const tryScroll = () => {
      rowVirtualizer.scrollToIndex(idx, { align: 'center' });
      attempts += 1;
      const landed = rowVirtualizer.getVirtualItems().some((v) => v.index === idx);
      if (landed || attempts >= 10) {
        scrolledToSelection.current = true;
        return;
      }
      raf = requestAnimationFrame(tryScroll);
    };
    raf = requestAnimationFrame(tryScroll);
    return () => cancelAnimationFrame(raf);
  }, [open, openSelectionKey, rows, rowVirtualizer]);

  function toggleCollapsed(key: string) {
    toggle(key);
    // Expanding a datasource that previously failed is a retry request; the
    // loader effect picks it up again once the failure memo is dropped.
    if (collapsed.has(key) && key.startsWith('ds:')) {
      const dsName = key.slice(3);
      setDsFailed((prev) => {
        if (!prev.has(dsName)) return prev;
        const next = new Set(prev);
        next.delete(dsName);
        return next;
      });
    }
  }

  function selectKey(key: string) {
    setSelectedKey(key);
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  const confirmKey = useCallback(
    (key: string) => {
      if (!target) return;
      // Component-prop mode: call componentPropSource.onPick with the selected key
      if (target.componentPropSource) {
        target.componentPropSource.onPick(key);
        closeBindingPicker();
        return;
      }
      // Var mode: build a VariableBinding and update the component
      const { datasource, path: rawPath } = parseVarKey(key);
      const { path, index: elementIndex } = resolveElementBinding(
        datasource,
        rawPath,
        findRawFolder(dsTree, key),
        dsTree,
      );
      const pickedVar = allVars.find((v) =>
        v._datasource && v._path
          ? `${v._datasource}:${v._path}` === `${datasource}:${path}`
          : false,
      );
      const binding: VariableBinding = {
        path: `${datasource}:${path}`,
        ...(elementIndex !== undefined ? { index: elementIndex } : {}),
      };
      if (target.onPick) {
        target.onPick(binding, {
          dataType: pickedVar?.data_type,
          isArray: pickedVar ? isArrayShape(pickedVar) : undefined,
          arrayLength:
            pickedVar && typeof pickedVar.array_length === 'number'
              ? pickedVar.array_length
              : undefined,
          index: elementIndex,
        });
      } else {
        updateComponent(target.componentId, {
          properties: { [target.propertyKey]: { $var: binding } },
        });
      }
      closeBindingPicker();
    },
    [target, allVars, updateComponent, closeBindingPicker, dsTree],
  );

  const handleConfirm = useCallback(() => {
    if (selectedKey) confirmKey(selectedKey);
  }, [confirmKey, selectedKey]);

  const handleConfirmTopSearchResult = useCallback(() => {
    const topKey = rows.map(rowSelectionKey).find((key): key is string => key !== null);
    if (topKey) confirmKey(topKey);
  }, [confirmKey, rows]);

  const handleClear = useCallback(() => {
    if (!target) return;
    // Component-prop mode: clear by calling onPick with empty string
    if (target.componentPropSource) {
      target.componentPropSource.onPick('');
      closeBindingPicker();
      return;
    }
    // Var mode: empty the binding but keep the property on `$var` — dropping
    // the property entirely would reset its source to `$static`, and for a
    // nested source (`$if`/`$compare`/…) it would delete the whole wrapper.
    const empty: VariableBinding = { path: '' };
    if (target.onPick) {
      target.onPick(empty);
    } else {
      updateComponent(target.componentId, {
        properties: { [target.propertyKey]: { $var: empty } },
      });
    }
    closeBindingPicker();
  }, [target, updateComponent, closeBindingPicker]);

  if (!open || !target) return null;

  // ── Derived values ────────────────────────────────────────────────────────

  const pickerTitle = isComponentPropMode
    ? (target.componentPropSource?.label ?? target.propertyKey)
    : (target.filter?.label ?? schemaField?.label ?? target.propertyKey);

  let componentPropMode: ComponentPropMode | null = null;
  let varMode: VarMode | null = null;
  let hasComponentPropTypeFilter = false;

  if (isComponentPropMode) {
    const fieldType = target.componentPropSource?.fieldType;
    const requiredFields = target.componentPropSource?.requiredFields;
    const isStructTarget = fieldType !== undefined && isStructType(primaryType(fieldType));
    hasComponentPropTypeFilter = fieldType !== undefined;
    const typeIsOk =
      componentPropSelectedItem && fieldType !== undefined
        ? componentPropSelectedItem.node
          ? componentPropSelectedItem.node.kind === 'variable'
            ? isCompatibleLeafNode(componentPropSelectedItem.node, fieldType)
            : isCompatibleFolderNode(componentPropSelectedItem.node, fieldType, requiredFields)
          : isCompatible(componentPropSelectedItem.propSchema, fieldType, requiredFields)
        : null;
    componentPropMode = {
      fieldType,
      requiredFields,
      requiredNamesSet: requiredFields?.length ? new Set(requiredFields.map(rfName)) : undefined,
      isStructTarget,
      typeIsOk,
      selectedItem: componentPropSelectedItem,
    };
  } else {
    const selectedVar =
      allVars.find((v) =>
        v._datasource && v._path ? `${v._datasource}:${v._path}` === selectedKey : false,
      ) ?? null;
    const selectedParsed = selectedKey ? parseVarKey(selectedKey) : null;
    const elemSuffix = selectedParsed?.path.match(/^(.+)\[(\d+)\]$/) ?? null;
    const selectedParentVar = elemSuffix
      ? (allVars.find((v) =>
          v._datasource && v._path
            ? `${v._datasource}:${v._path}` === `${selectedParsed!.datasource}:${elemSuffix[1]}`
            : false,
        ) ?? null)
      : null;
    const selectedElementIndex = elemSuffix ? parseInt(elemSuffix[2], 10) : undefined;
    const isStruct =
      schemaField?.type !== undefined &&
      isStructType(primaryType(schemaField.type)) &&
      schemaField?.requiredFields !== undefined;

    let scalarIsValid: boolean | null = null;
    if (!isStruct) {
      const varToCheck = selectedVar ?? selectedParentVar;
      if (varToCheck) {
        const allowed = schemaField?.type !== undefined ? acceptedValueTypes(schemaField.type) : [];
        // Validate the resolved binding: a whole variable keeps its array-ness,
        // an array element (selectedParentVar) de-arrays to a scalar.
        const resolved = selectedVar ? nodeVarType(varToCheck) : elementOf(nodeVarType(varToCheck));
        const typeOk =
          allowed.length === 0 || allowed.some((t) => accepts(parseTypeToken(t), resolved));
        const accessOk = !schemaField?.write || varToCheck.writable === true;
        scalarIsValid = typeOk && accessOk;
      }
    }
    varMode = {
      schemaField,
      selectedVar,
      selectedParentVar,
      selectedElementIndex,
      rawSelectedFolder,
      scalarIsValid,
      isStruct,
    };
  }

  // ── Right panel ───────────────────────────────────────────────────────────

  const rightPanel = (
    <RightPanel
      pickerTitle={pickerTitle}
      selectedKey={selectedKey}
      varMode={varMode}
      componentPropMode={componentPropMode}
    />
  );

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <BindingPickerShell
      title={pickerTitle}
      action={isComponentPropMode ? 'Select property' : 'Select binding'}
      onClose={closeBindingPicker}
      onConfirm={handleConfirm}
      onClear={handleClear}
      confirmDisabled={!selectedKey}
      search={search}
      onSearchChange={setSearch}
      onSearchEnter={isComponentPropMode ? undefined : handleConfirmTopSearchResult}
      searchPlaceholder={
        isComponentPropMode ? 'Search by label or key…' : 'Search by name or node ID…'
      }
      showAllCheckbox={
        isComponentPropMode
          ? hasComponentPropTypeFilter
          : !!(
              schemaField?.type !== undefined &&
              (acceptedValueTypes(schemaField.type).length > 0 ||
                isStructType(primaryType(schemaField.type)))
            )
      }
      showAll={showAll}
      onShowAllChange={setShowAll}
      loadError={isComponentPropMode ? null : loadError}
      listRef={listRef}
      listContent={
        <SearchHighlightProvider query={withDotSearchSeparators(search)}>
          <VirtualTreeRows
            rows={rows}
            virtualizer={rowVirtualizer}
            emptyState={
              <p className="editor-binding-empty">
                {isComponentPropMode
                  ? 'No compatible properties found.'
                  : 'No compatible variables found.'}
              </p>
            }
            renderRow={(item) => {
              const ctx: RowContext = {
                rowStyle: {
                  '--row-indent': treePaddingLeft(item.depth, { stepRem: 1, baseRem: 1 }),
                } as CSSProperties,
                selectedKey,
                collapsed,
                toggleCollapsed,
                selectKey,
                onPickAndClose: (key) => {
                  target.componentPropSource?.onPick(key);
                  closeBindingPicker();
                },
                dsLoading,
              };
              return <PickerRow item={item} ctx={ctx} />;
            }}
          />
        </SearchHighlightProvider>
      }
      rightPanel={rightPanel}
    />
  );
}
