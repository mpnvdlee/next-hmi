/**
 * DatasourceVariableTable — center panel for the VariablesView.
 *
 * Shows the variable tree table for the selected datasource.
 * Supports:
 * - OPC-UA Client: browse PLC, enable/disable, save
 * - Static Variables: inline add/edit/remove, name + type + value
 * - OPC-UA Test Server: tree editor with add folder/variable
 *
 * Virtualised with @tanstack/react-virtual for large trees.
 * Live values subscribe only to visible variables to avoid re-render storms.
 * Priority subscription keys are sent to the WebSocket server on scroll.
 */

import './style.css';
import type { DatasourceConfig, TreeNode } from '@shared/types/datasource';
import DatasourceBrowseDiffBanner from './DatasourceBrowseDiffBanner';
import DatasourceVariableToolbar from './DatasourceVariableToolbar';
import DatasourceVariableVirtualTable from './DatasourceVariableVirtualTable';
import { useDatasourceVariableTableController } from './useDatasourceVariableTableController';
import ConfigWorkspace from '../../ui/ConfigWorkspace';

// ── Props ───────────────────────────────────────────────────────────────────

interface Props {
  datasource: DatasourceConfig | null;
  onVariablesChange: (variables: TreeNode[]) => void;
  error?: string | null;
}

// ── Component ───────────────────────────────────────────────────────────────

export default function DatasourceVariableTable({
  datasource,
  onVariablesChange,
  error = null,
}: Props) {
  const {
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
  } = useDatasourceVariableTableController({ datasource, onVariablesChange });

  // ── Render ──────────────────────────────────────────────────────────────

  const toolbarState = {
    dsType,
    showLive,
    filter,
    browsing: browsing || hasPendingBrowse,
  };

  const toolbarActions = {
    onToggleLive: () => setShowLive((value) => !value),
    onCollapseAll: collapseAll,
    onExpandAll: expandAll,
    onFilterChange: setFilter,
    onBrowse: handleBrowse,
  };

  const tableState = {
    scrollRef,
    colsTmpl,
    showLive,
    isEditable,
    rows,
    rowVirtualizer,
    collapsed,
    dsName,
    liveValues,
    filter,
    dsType,
  };

  const tableActions = {
    onToggleFolder: toggleFolder,
    onSetFolderEnabled: setFolderEnabled,
    onRemoveNode: removeNode,
    onUpdateVar: updateVar,
    onAddVariable: addVariable,
    onAddFolder: addFolder,
    onAddArray: addArray,
    onAddArrayStruct: addArrayStruct,
    onUpdateArrayLength: updateArrayLength,
    onRenameFolder: renameFolder,
  };

  return (
    <ConfigWorkspace
      title="Datasources"
      actions={
        datasource ? (
          <DatasourceVariableToolbar state={toolbarState} actions={toolbarActions} />
        ) : undefined
      }
    >
      {error && <div className="cfg-error-banner">{error}</div>}
      {!datasource ? (
        <div className="cfg-panel-empty">Select a datasource from the left panel.</div>
      ) : (
        <>
          {browseError && <div className="cfg-error-banner">{browseError}</div>}

          {hasPendingBrowse && (
            <DatasourceBrowseDiffBanner dsName={dsName} onApply={applyPendingBrowse} />
          )}

          <DatasourceVariableVirtualTable state={tableState} actions={tableActions} />
        </>
      )}
    </ConfigWorkspace>
  );
}
