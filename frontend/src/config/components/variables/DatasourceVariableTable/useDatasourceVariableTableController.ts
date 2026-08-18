import { useState, useRef, useCallback, useEffect } from 'react';
import { useVariablesDomainStore } from '@config/store/domains/variablesDomainStore';
import {
  DATASOURCE_CAPABILITIES,
  type DatasourceConfig,
  type TreeNode,
} from '@shared/types/datasource';
import { applyBrowseDiff, type BrowseDiff } from './datasourceBrowseDiff';
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

  const { browsing, browseError, handleBrowse } = useDatasourceBrowse({
    dsName,
    latestTree,
    applyTreeUpdate,
  });

  // One-shot auto-browse requested by the connection wizard: fire once the new
  // datasource reports connected (the /browse endpoint needs a live session),
  // then clear the request. The toolbar "Browse PLC" stays as manual fallback.
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

  const { rows, rowVirtualizer, colsTmpl } = useDatasourceTableRows({
    tree,
    filter,
    collapsed,
    showLive,
    isEditable,
    scrollRef,
  });

  const liveValues = useLiveValues({
    showLive,
    dsName,
    rows,
    virtualizer: rowVirtualizer,
    scrollRef,
  });

  return {
    datasource,
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
