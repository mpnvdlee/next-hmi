import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useVariablesDomainStore } from '@config/store/domains/variablesDomainStore';
import {
  DATASOURCE_CAPABILITIES,
  type DatasourceConfig,
  type TreeNode,
} from '@shared/types/datasource';
import { apiJson } from '@shared/utils/api';
import { applyBrowseDiff, type BrowseDiff } from './datasourceBrowseDiff';
import {
  applyPlcCheck,
  mergeBrowseSelection,
  newLeafIds,
  nodeKey,
  savedNodeIds,
  staleRows,
} from './browseMerge';
import type { PlcMarks, PlcOverlay } from './plcRows';
import { useAdsPlcBrowse } from './useAdsPlcBrowse';
import { useDatasourceBrowse } from './useDatasourceBrowse';
import { useDatasourceSaveRegistration } from './useDatasourceSaveRegistration';
import { useDatasourceDraftLifecycle } from './useDatasourceDraftLifecycle';
import { useDatasourceTableRows } from './useDatasourceTableRows';
import { useDatasourceTreeMutations } from './useDatasourceTreeMutations';
import { useLiveValues } from './useLiveValues';

interface Params {
  datasource: DatasourceConfig | null;
  onVariablesChange: (variables: TreeNode[]) => void;
}

export function useDatasourceVariableTableController({ datasource, onVariablesChange }: Params) {
  const setVarsDraft = useVariablesDomainStore((s) => s.setVarsDraft);
  const clearVarsDraft = useVariablesDomainStore((s) => s.clearVarsDraft);
  const setCollapsedDraft = useVariablesDomainStore((s) => s.setCollapsedDraft);
  const setPendingBrowse = useVariablesDomainStore((s) => s.setPendingBrowse);
  const hasPendingBrowse = useVariablesDomainStore((s) =>
    datasource?.name ? s.pendingBrowse[datasource.name] != null : false,
  );

  const [filter, setFilter] = useState('');
  const [showLive, setShowLive] = useState(false);
  const { tree, setTree, dirty, setDirty, collapsed, setCollapsed, latestTree } =
    useDatasourceDraftLifecycle({
      datasource,
      setVarsDraft,
      clearVarsDraft,
      setCollapsedDraft,
    });

  const dsName = datasource?.name ?? '';
  const dsType = datasource?.type ?? 'opcua-client';
  // The hasPendingBrowse gate is only meaningful for opcua-test-server (the
  // browsable type that's also editable); for opcua-client editable is already
  // false, for static there's no browse flow.
  const isEditable = DATASOURCE_CAPABILITIES[dsType].editable && !hasPendingBrowse;

  const scrollRef = useRef<HTMLDivElement>(null);

  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useDatasourceSaveRegistration({
    dsName,
    latestTree,
    dirtyRef,
    clearVarsDraft,
    onVariablesChange,
    setDirty,
  });

  const {
    applyTreeUpdate,
    updateVar,
    toggleFolder,
    collapseAll,
    expandAll,
    addVariable,
    addFolder,
    addArray,
    addArrayStruct,
    updateArrayLength,
    removeNode,
    renameFolder,
    setFolderEnabled,
  } = useDatasourceTreeMutations({
    latestTree,
    setTree,
    setDirty,
    setCollapsed,
  });

  const {
    browsing,
    browseError,
    progress: browseProgress,
    handleBrowse: handleFullBrowse,
  } = useDatasourceBrowse({
    dsName,
    latestTree,
    applyTreeUpdate,
  });

  // An ADS PLC is browsed a level or the marked variables at a time, so
  // instead of diffing one complete browse against the saved tree, its
  // toolbar shows the PLC's new variables in the table, each added
  // (add-only) when ticked.
  const isAds = dsType === 'ads-client';
  // The datasource it was switched on for: selecting another switches it off
  // in the same render, before that one is browsed unasked.
  const [plcShownFor, setPlcShownFor] = useState<string | null>(null);
  const showPlc = plcShownFor === dsName;
  const plcBrowse = useAdsPlcBrowse(dsName, isAds && showPlc);
  const { refresh: refreshPlc } = plcBrowse;
  // Every start browses afresh: a download since the last one shows.
  const startPlc = useCallback(() => {
    refreshPlc();
    setPlcShownFor(dsName);
  }, [refreshPlc, dsName]);
  const handleBrowse = useCallback(async () => {
    if (isAds) startPlc();
    else await handleFullBrowse();
  }, [isAds, startPlc, handleFullBrowse]);
  const togglePlc = useCallback(() => {
    if (showPlc) setPlcShownFor(null);
    else startPlc();
  }, [showPlc, startPlc]);

  // While browsing, what the PLC says of the saved variables: gone (red) or
  // there with another data type (orange). Only marks — the tree is unchanged.
  const [plcMarks, setPlcMarks] = useState<PlcMarks | null>(null);
  useEffect(() => {
    setPlcMarks(null);
    if (!isAds || !showPlc) return;
    let live = true;
    apiJson<{ missing: string[]; changed?: Record<string, string> }>(
      `/api/datasources/${encodeURIComponent(dsName)}/check-variables`,
      { method: 'POST' },
    )
      .then(({ missing, changed = {} }) => {
        if (!live) return;
        setPlcMarks({
          missing: new Set(missing.map(nodeKey)),
          changed: new Map(Object.entries(changed).map(([id, type]) => [nodeKey(id), type])),
          error: null,
        });
      })
      .catch((err: unknown) => {
        if (!live) return;
        setPlcMarks({
          missing: new Set(),
          changed: new Map(),
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      live = false;
    };
  }, [isAds, showPlc, dsName]);
  const { nodes: plcNodes, open: plcOpen, loaded: plcLoaded, loading: plcLoading } = plcBrowse;
  const addFromPlc = useCallback(
    (ids: string[]) => {
      if (!plcNodes || ids.length === 0) return;
      applyTreeUpdate((prev) => mergeBrowseSelection(prev, plcNodes, new Set(ids)));
    },
    [applyTreeUpdate, plcNodes],
  );
  const saved = useMemo(() => savedNodeIds(tree), [tree]);
  const plcOverlay = useMemo((): PlcOverlay | null => {
    if (!isAds || !showPlc || !plcNodes) return null;
    return { nodes: plcNodes, saved, open: plcOpen, loaded: plcLoaded, loading: plcLoading };
  }, [isAds, showPlc, plcNodes, saved, plcOpen, plcLoaded, plcLoading]);
  const plcNewCount = useMemo(
    () => (plcNodes ? newLeafIds(plcNodes, saved).length : 0),
    [plcNodes, saved],
  );

  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<{ ok: boolean; message: string } | null>(null);
  const dismissCheckResult = useCallback(() => setCheckResult(null), []);
  // A result describes the tree it was checked against: gone once that
  // changes — except by the check's own stale-flag update.
  const checkUpdatedTree = useRef(false);
  useEffect(() => {
    if (checkUpdatedTree.current) checkUpdatedTree.current = false;
    else setCheckResult(null);
  }, [dsName, tree]);
  // The backend checks the saved variables, so nothing saved means nothing to check.
  const canCheck = savedNodeIds(datasource?.variables ?? []).size > 0;

  // Marks saved variables the PLC no longer has stale, and clears the mark on
  // the ones it has again. Removing one stays the user's call: the stale rows
  // are offered in the browse banner, unticked.
  //
  // The backend checks the *saved* variables (its registry), not this draft: a
  // variable added since the last save is not in `missing`, so it counts as
  // present until the project is saved and checked again.
  const checkAgainstPlc = useCallback(async () => {
    setChecking(true);
    setCheckResult(null);
    try {
      const { missing } = await apiJson<{ missing: string[] }>(
        `/api/datasources/${encodeURIComponent(dsName)}/check-variables`,
        { method: 'POST' },
      );
      if (useVariablesDomainStore.getState().selectedName !== dsName) return;
      const gone = new Set(missing);
      const checked = applyPlcCheck(latestTree.current, gone);
      if (checked !== latestTree.current) {
        checkUpdatedTree.current = true;
        applyTreeUpdate((prev) => applyPlcCheck(prev, gone));
      }
      const stale = staleRows(checked);
      if (stale.length > 0) {
        setPendingBrowse(dsName, {
          diff: { added: [], removed: stale, modified: [], silentReactivations: [] },
        });
      } else {
        setCheckResult({ ok: true, message: 'Every saved variable exists on the PLC.' });
      }
    } catch (error: unknown) {
      setCheckResult({
        ok: false,
        message: `Check against PLC failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      setChecking(false);
    }
  }, [applyTreeUpdate, dsName, latestTree, setPendingBrowse]);

  // One-shot auto-browse requested by the connection wizard: fire once the new
  // datasource reports connected (the /browse endpoint needs a live session),
  // then clear the request. The toolbar's "Browse PLC" (ADS: "Show PLC
  // variables") stays as manual fallback.
  const browseRequested = useVariablesDomainStore(
    (s) => s.browseRequestName === dsName && dsName !== '',
  );
  const isConnected = useVariablesDomainStore(
    (s) => s.datasources.find((d) => d.name === dsName)?.connected ?? false,
  );
  const clearBrowseRequest = useVariablesDomainStore((s) => s.clearBrowseRequest);
  useEffect(() => {
    if (browseRequested && isConnected && !browsing && !hasPendingBrowse) {
      clearBrowseRequest();
      void handleBrowse();
    }
  }, [browseRequested, isConnected, browsing, hasPendingBrowse, clearBrowseRequest, handleBrowse]);

  const applyPendingBrowse = useCallback(
    (diff: BrowseDiff, selected: ReadonlySet<string>) => {
      // Apply against the *current* tree, not a snapshot from browse time,
      // so any edits the user made while reviewing aren't clobbered.
      applyTreeUpdate((prev) => applyBrowseDiff({ savedTree: prev, diff, selected }));
    },
    [applyTreeUpdate],
  );

  const { rows, wanted, rowVirtualizer, colsTmpl } = useDatasourceTableRows({
    tree,
    filter,
    collapsed,
    showLive,
    isEditable,
    scrollRef,
    plc: plcOverlay,
  });

  const { ensureLoaded } = plcBrowse;
  useEffect(() => {
    if (wanted.length > 0) ensureLoaded(wanted);
  }, [wanted, ensureLoaded]);

  const liveValues = useLiveValues({
    showLive,
    dsName,
    rows,
    virtualizer: rowVirtualizer,
    scrollRef,
  });

  return {
    datasource,
    tree,
    showPlc,
    togglePlc,
    plcBrowse,
    plcMarks,
    plcNewCount,
    addFromPlc,
    isConnected,
    checking,
    checkResult,
    dismissCheckResult,
    canCheck,
    checkAgainstPlc,
    dsName,
    dsType,
    isEditable,
    hasPendingBrowse,
    filter,
    setFilter,
    showLive,
    setShowLive,
    collapseAll,
    expandAll,
    browsing,
    handleBrowse,
    applyPendingBrowse,
    addVariable,
    addFolder,
    addArray,
    addArrayStruct,
    updateArrayLength,
    browseError,
    browseProgress,
    scrollRef,
    colsTmpl,
    rows,
    rowVirtualizer,
    collapsed,
    toggleFolder,
    setFolderEnabled,
    removeNode,
    renameFolder,
    liveValues,
    updateVar,
  };
}
