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
import {
  accepts,
  elementOf,
  formatVarType,
  nodeVarType,
  parseTypeToken,
} from '@shared/types/varType';
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
import { allPageRootNodes } from '@shared/utils/pageTree';
import { apiJson } from '@shared/utils/api';
import { withDotSearchSeparators } from '@shared/utils/search';
import type { ComponentPropertySchema, StructSchemaNode } from '@shared/types/componentProperty';
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
  componentPropVerdict,
  propSlotOf,
  structSchemaNodeVerdict,
} from './componentPropHelpers';
import { ComponentPropPath } from './ComponentPropPath';
import RightPanel, {
  type ComponentPropMode,
  type ComponentPropSelectedItem,
  type VarMode,
} from './RightPanel';
import { varStructVerdict } from './helpers';
import {
  REPEAT_INDEX_SUFFIX,
  repeatPickMembers,
  REPEAT_KEY_PREFIX,
  REPEAT_SOURCE_KEY,
  isPickableRepeatKey,
  isRepeatKey,
  repeatItemProperties,
  repeatPickFromKey,
  repeatPickKey,
  repeatPickFits,
  repeatPickLabel,
  repeatPickVarType,
} from './repeatItemRows';

type TreeNode = PickerTreeNode;
type VariableEntry = PickerVariableEntry;

/** Collapse key for the component-prop mode's single source row. Namespaced so it
 *  can never collide with a property key. */
const COMPONENT_PROP_SOURCE_KEY = 'source:componentProps';

/** A component-prop key resolved against the properties on offer: a top-level
 *  property or a node inside a struct property's schema. */
function componentPropItem(
  properties: Record<string, ComponentPropertySchema>,
  key: string,
): ComponentPropSelectedItem | null {
  const slashIdx = key.indexOf('/');
  const propKey = slashIdx === -1 ? key : key.slice(0, slashIdx);
  const propSchema = properties[propKey];
  if (!propSchema) return null;
  let node: StructSchemaNode | null = null;
  if (slashIdx !== -1) {
    let nodes = propSchema.structSchema ?? [];
    for (const part of key.slice(slashIdx + 1).split('/')) {
      node = nodes.find((n) => n.name === part) ?? null;
      if (!node) return null;
      nodes = node.children ?? [];
    }
  }
  return {
    propKey,
    propSchema,
    node,
    structNodes: node ? (node.children ?? null) : (propSchema.structSchema ?? null),
    displayLabel: <ComponentPropPath value={key} properties={properties} />,
  };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function VariableBindingPicker() {
  const open = useEditorDomainStore((s) => s.bindingPickerOpen);
  const target = useEditorDomainStore((s) => s.bindingPickerTarget);
  const closeBindingPicker = useEditorDomainStore((s) => s.closeBindingPicker);

  const pages = useConfigStore((s) => s.pages);
  const dialogs = useConfigStore((s) => s.dialogs);
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
  // Repeat item mode lists only the Repeater copy's element — a source of its
  // own, never mixed in with the datasources.
  const repeatOptions = isComponentPropMode ? undefined : target?.repeatItem;
  const loadsDatasources = !isComponentPropMode && !repeatOptions;

  // Find the target component and its current binding (var mode only)
  const comp = useMemo(
    () =>
      !isComponentPropMode && target
        ? findComponentInPages(allPageRootNodes({ pages, dialogs }), target.componentId)
        : null,
    [isComponentPropMode, target, pages, dialogs],
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
    if (wrapped.repeatIndex) return `${base}${REPEAT_INDEX_SUFFIX}`;
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
      setSelectedKey(
        target?.repeatItem?.current ? repeatPickKey(target.repeatItem.current) : currentKey,
      );
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

  // The Repeat item rows follow the same type filter as the variables.
  const repeatProperties = useMemo(
    () =>
      repeatOptions
        ? repeatItemProperties(
            repeatOptions,
            showAll ? undefined : (pick) => repeatPickFits(pick, repeatOptions, schemaField),
          )
        : null,
    [repeatOptions, showAll, schemaField],
  );

  // ── Var mode: Phase 1 — load datasource headers on open ──────────────────

  useEffect(() => {
    if (!open || !loadsDatasources) return;
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
  }, [open, loadsDatasources, setCollapsed]);

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
    if (!open || !loadsDatasources) return;
    for (const ds of dsTree) {
      if (collapsed.has(`ds:${ds.name}`)) continue;
      if (dsLoaded.has(ds.name) || dsLoading.has(ds.name) || dsFailed.has(ds.name)) continue;
      loadDatasource(ds.name);
    }
  }, [open, loadsDatasources, dsTree, collapsed, dsLoaded, dsLoading, dsFailed, loadDatasource]);

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
    if (!loadsDatasources) return;
    const wasEmpty = prevSearch.current.trim() === '';
    const isNowActive = search.trim() !== '';
    prevSearch.current = search;
    if (!isNowActive || !wasEmpty) return;
    for (const ds of dsTree) {
      if (!dsLoaded.has(ds.name) && !dsLoading.has(ds.name) && !dsFailed.has(ds.name)) {
        loadDatasource(ds.name);
      }
    }
  }, [loadsDatasources, search, dsTree, dsLoaded, dsLoading, dsFailed, loadDatasource]);

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
      const { properties, fieldType, requiredFields, write } = target.componentPropSource;
      const propRows = buildComponentPropRows(
        properties,
        fieldType,
        requiredFields,
        search,
        showAll,
        collapsed,
        { baseDepth: 1, write },
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
    if (repeatProperties) {
      const repeatRows = buildComponentPropRows(
        repeatProperties,
        undefined,
        undefined,
        search,
        true,
        collapsed,
        { keyPrefix: REPEAT_KEY_PREFIX, baseDepth: 1, searchPath: 'Repeat item' },
      );
      if (repeatRows.length === 0) return repeatRows;
      const source: RowItem = {
        kind: 'component-prop-source',
        key: REPEAT_SOURCE_KEY,
        name: 'Repeat item',
        meta: 'this copy',
        depth: 0,
      };
      return collapsed.has(REPEAT_SOURCE_KEY) && !search.trim()
        ? [source]
        : [source, ...repeatRows];
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
    return flattenForRender(
      filtered,
      0,
      search.trim() ? new Set() : collapsed,
      target?.repeatIndex === true,
    );
  }, [isComponentPropMode, target, typedDsTree, search, showAll, collapsed, repeatProperties]);

  // All variable entries across all datasources (for var-mode right panel lookup)
  const allVars = useMemo(() => {
    if (isComponentPropMode) return [];
    const out: VariableEntry[] = [];
    for (const ds of dsTree) {
      out.push(...flattenAll(ds.children, ds.name));
    }
    return out;
  }, [isComponentPropMode, dsTree]);

  // The type-filtered tree a selected folder is judged against, even while
  // "Show all" lists everything.
  const strictDsTree = useMemo(
    () =>
      isComponentPropMode || !showAll
        ? typedDsTree
        : dsTree.map((ds) => ({
            ...ds,
            children: typeFilter(ds.children, schemaField, includeDisabled),
          })),
    [isComponentPropMode, showAll, dsTree, typedDsTree, schemaField, includeDisabled],
  );

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

  /** What the drawer shows for a key — the Required/Selected panes and the
   *  ✓/✗ they carry. Judged for any key, not only the selected one, so a
   *  double-click or Enter pick is held to the same verdict as Confirm. */
  function modesFor(key: string | null): {
    componentPropMode: ComponentPropMode | null;
    varMode: VarMode | null;
  } {
    if (!target) return { componentPropMode: null, varMode: null };
    if (target.componentPropSource) {
      const { properties, fieldType, requiredFields, write } = target.componentPropSource;
      const selectedItem = key ? componentPropItem(properties, key) : null;
      const slot = propSlotOf(fieldType, requiredFields, write);
      // Selected but not found (a property since removed) is a mismatch; an
      // unconstrained field accepts whatever is picked.
      const verdict = !selectedItem
        ? { ok: false }
        : !slot
          ? { ok: true }
          : selectedItem.node
            ? structSchemaNodeVerdict(selectedItem.node, slot)
            : componentPropVerdict(selectedItem.propSchema, slot);
      const typeIsOk = key ? verdict.ok : null;
      return {
        componentPropMode: {
          fieldType,
          requiredFields,
          requiredNamesSet: requiredFields?.length
            ? new Set(requiredFields.map(rfName))
            : undefined,
          isStructTarget: fieldType !== undefined && isStructType(primaryType(fieldType)),
          typeIsOk,
          mismatchReason: key ? verdict.reason : undefined,
          selectedItem,
        },
        varMode: null,
      };
    }
    const selectedVar =
      allVars.find((v) =>
        v._datasource && v._path ? `${v._datasource}:${v._path}` === key : false,
      ) ?? null;
    const selectedParsed = key ? parseVarKey(key) : null;
    const elemSuffix = selectedParsed?.path.match(/^(.+)\[(\d+|#)\]$/) ?? null;
    const selectedParentVar = elemSuffix
      ? (allVars.find((v) =>
          v._datasource && v._path
            ? `${v._datasource}:${v._path}` === `${selectedParsed!.datasource}:${elemSuffix[1]}`
            : false,
        ) ?? null)
      : null;
    const selectedElementIndex = !elemSuffix
      ? undefined
      : elemSuffix[2] === '#'
        ? ('#' as const)
        : parseInt(elemSuffix[2], 10);
    const isStruct =
      schemaField?.type !== undefined &&
      isStructType(primaryType(schemaField.type)) &&
      schemaField?.requiredFields !== undefined;
    const rawSelectedFolder = key ? findRawFolder(dsTree, key) : null;
    // Whether the selected folder is one the field accepts — judged against the
    // type-filtered tree even while "Show all" lists everything.
    const strictFolderSelectable = !!key && findRawFolder(strictDsTree, key)?.selectable === true;

    const allowed = schemaField?.type !== undefined ? acceptedValueTypes(schemaField.type) : [];
    const needsWrite = schemaField?.write === true;
    const repeatPick = isRepeatKey(key) ? repeatPickFromKey(key) : null;
    const repeatType =
      repeatPick && repeatOptions ? repeatPickVarType(repeatPick, repeatOptions.scope) : null;
    const repeatWritable =
      !!repeatPick && repeatPick.field !== 'index' && !!repeatOptions?.scope.writable;
    // A selection whose datasource is still loading is not judged yet; once it
    // has loaded, a key that resolves to nothing is a binding that no longer exists.
    const pendingDatasource =
      !!selectedParsed?.datasource &&
      !repeatPick &&
      !dsLoaded.has(selectedParsed.datasource) &&
      !dsFailed.has(selectedParsed.datasource);

    let scalarIsValid: boolean | null = null;
    if (key && !isStruct) {
      const varToCheck = selectedVar ?? selectedParentVar;
      if (repeatPick && repeatOptions) {
        scalarIsValid = repeatPickFits(repeatPick, repeatOptions, schemaField);
      } else if (varToCheck) {
        // Validate the resolved binding: a whole variable keeps its array-ness,
        // an array element (selectedParentVar) de-arrays to a scalar.
        const resolved = selectedVar ? nodeVarType(varToCheck) : elementOf(nodeVarType(varToCheck));
        const typeOk =
          allowed.length === 0 || allowed.some((t) => accepts(parseTypeToken(t), resolved));
        const accessOk = !needsWrite || varToCheck.writable === true;
        scalarIsValid = typeOk && accessOk;
      } else if (rawSelectedFolder) {
        scalarIsValid = strictFolderSelectable;
      } else if (!pendingDatasource) {
        scalarIsValid = false;
      }
    }
    return {
      componentPropMode: null,
      varMode: {
        repeatSelected:
          repeatPick && repeatOptions
            ? {
                label: repeatPickLabel(repeatPick),
                type: repeatType
                  ? formatVarType(repeatType)
                  : (repeatOptions.scope.elementType ?? undefined),
                writable: repeatWritable,
                ...repeatPickMembers(repeatPick, repeatType, repeatOptions.scope),
              }
            : undefined,
        pendingSelection: !!key && pendingDatasource && !selectedVar && !rawSelectedFolder,
        strictFolderSelectable,
        schemaField,
        selectedVar,
        selectedParentVar,
        selectedElementIndex,
        rawSelectedFolder,
        scalarIsValid,
        isStruct,
      },
    };
  }

  /** A key the drawer does not mark ✗ — still-loading selections included.
   *  Every way of picking (Confirm, Enter, double-click) goes through here. */
  function isConfirmable(key: string): boolean {
    if (isRepeatKey(key) && !(repeatOptions && isPickableRepeatKey(key, repeatOptions))) {
      return false;
    }
    const modes = modesFor(key);
    if (modes.componentPropMode) return modes.componentPropMode.typeIsOk !== false;
    const mode = modes.varMode!;
    const verdict = mode.isStruct ? varStructVerdict(mode, true) : mode.scalarIsValid;
    return verdict !== false;
  }

  const { componentPropMode, varMode } = modesFor(selectedKey);
  const hasComponentPropTypeFilter = target.componentPropSource?.fieldType !== undefined;

  function confirmKey(key: string) {
    if (!target || !isConfirmable(key)) return;
    if (target.repeatItem && isRepeatKey(key)) {
      const pick = repeatPickFromKey(key);
      if (!pick) return;
      target.repeatItem.onPick(pick);
      closeBindingPicker();
      return;
    }
    // Component-prop mode: call componentPropSource.onPick with the selected key
    if (target.componentPropSource) {
      target.componentPropSource.onPick(key);
      closeBindingPicker();
      return;
    }
    // Var mode: build a VariableBinding and update the component
    const { datasource, path: rawPath } = parseVarKey(key);
    let binding: VariableBinding;
    let meta: Parameters<NonNullable<typeof target.onPick>>[1];
    if (rawPath.endsWith(REPEAT_INDEX_SUFFIX)) {
      // The Repeater copy's own position in a parallel array.
      binding = {
        path: `${datasource}:${rawPath.slice(0, -REPEAT_INDEX_SUFFIX.length)}`,
        repeatIndex: true,
      };
    } else {
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
      binding = {
        path: `${datasource}:${path}`,
        ...(elementIndex !== undefined ? { index: elementIndex } : {}),
      };
      meta = {
        dataType: pickedVar?.data_type,
        isArray: pickedVar ? isArrayShape(pickedVar) : undefined,
        arrayLength:
          pickedVar && typeof pickedVar.array_length === 'number'
            ? pickedVar.array_length
            : undefined,
        index: elementIndex,
      };
    }
    if (target.onPick) target.onPick(binding, meta);
    else {
      updateComponent(target.componentId, {
        properties: { [target.propertyKey]: { $var: binding } },
      });
    }
    closeBindingPicker();
  }

  function handleConfirm() {
    if (selectedKey) confirmKey(selectedKey);
  }

  // Under "Show all" the top row may be one the field refuses; Enter takes
  // the first one it accepts instead.
  function handleConfirmTopSearchResult() {
    const topKey = rows
      .map(rowSelectionKey)
      .find((key): key is string => key !== null && isConfirmable(key));
    if (topKey) confirmKey(topKey);
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
      confirmDisabled={!selectedKey || !isConfirmable(selectedKey)}
      search={search}
      onSearchChange={setSearch}
      onSearchEnter={loadsDatasources ? handleConfirmTopSearchResult : undefined}
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
      loadError={loadsDatasources ? loadError : null}
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
                  : repeatOptions
                    ? 'Nothing in the Repeat item fits this field.'
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
                onPickAndClose: confirmKey,
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
