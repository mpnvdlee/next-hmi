/**
 * DatasourceVariableTable — center panel for the VariablesView.
 *
 * Shows the variable tree table for the selected datasource.
 * Supports:
 * - OPC-UA Client: browse PLC, enable/disable, save
 * - Beckhoff ADS: Browse PLC shows the PLC in the table — new variables to
 *   tick and add, saved ones it lacks (red) or types differently (orange) —
 *   and check against PLC
 * - Static Variables: inline add/edit/remove, name + type + value
 * - OPC-UA Test Server: tree editor with add folder/variable
 *
 * Virtualised with @tanstack/react-virtual for large trees.
 * Live values subscribe only to visible variables to avoid re-render storms.
 * Priority subscription keys are sent to the WebSocket server on scroll.
 */

import './style.css';
import type { DatasourceConfig, TreeNode } from '@shared/types/datasource';
import PlcBrowseNote from './PlcBrowseNote';
import DatasourceBrowseDiffBanner from './DatasourceBrowseDiffBanner';
import DatasourceBrowseProgress from './DatasourceBrowseProgress';
import DatasourceVariableToolbar from './DatasourceVariableToolbar';
import DatasourceVariableVirtualTable from './DatasourceVariableVirtualTable';
import { useDatasourceVariableTableController } from './useDatasourceVariableTableController';
import Button from '../../ui/Button';
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
  } = useDatasourceVariableTableController({ datasource, onVariablesChange });

  // ── Render ──────────────────────────────────────────────────────────────

  const toolbarState = {
    dsType,
    showLive,
    filter,
    browsing,
    // A pending review blocks a new browse, which keeps its label.
    browseDisabled: hasPendingBrowse,
    checking,
    canCheck,
    plcShown: showPlc,
    connected: isConnected,
  };

  const toolbarActions = {
    onToggleLive: () => setShowLive((value) => !value),
    onCollapseAll: collapseAll,
    onExpandAll: expandAll,
    onFilterChange: setFilter,
    onBrowse: () => void handleBrowse(),
    onCheck: () => void checkAgainstPlc(),
    onTogglePlc: togglePlc,
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
    plcMarks: showPlc ? plcMarks : null,
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
    onAddFromPlc: addFromPlc,
    onTogglePlcFolder: plcBrowse.toggleOpen,
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
          {browseProgress && <DatasourceBrowseProgress progress={browseProgress} />}
          {browseError && <div className="cfg-error-banner">{browseError}</div>}
          {checkResult && (
            <div
              className={`cfg-var-check-banner ${checkResult.ok ? 'cfg-success-banner' : 'cfg-error-banner'}`}
              role="status"
            >
              <span>{checkResult.message}</span>
              <Button variant="ghost" size="sm" onClick={dismissCheckResult}>
                Dismiss
              </Button>
            </div>
          )}

          {hasPendingBrowse && (
            <DatasourceBrowseDiffBanner
              dsName={dsName}
              onApply={applyPendingBrowse}
              plcCheck={dsType === 'ads-client'}
            />
          )}

          {showPlc && (
            <PlcBrowseNote
              browse={plcBrowse}
              marks={plcMarks}
              savedTree={tree}
              newCount={plcNewCount}
              filtering={filter.trim() !== ''}
              attributes={
                datasource.type === 'ads-client' && 'browse_attributes' in datasource.settings
                  ? datasource.settings.browse_attributes
                  : undefined
              }
            />
          )}

          <DatasourceVariableVirtualTable state={tableState} actions={tableActions} />
        </>
      )}
    </ConfigWorkspace>
  );
}
