/**
 * VariablesView — /config/datasources
 *
 * Three-panel layout (same grid as EditorView) for managing multiple datasources:
 *   Left:   DatasourceTree — list of datasources with add/delete
 *   Center: DatasourceVariableTable — variable tree for the selected datasource
 *   Right:  DatasourcePropertiesPanel — connection settings for the selected datasource
 */

import { useEffect, useCallback } from 'react';
import ConfigLayout from '../components/ui/ConfigLayout';
import DatasourceTree from '../components/variables/DatasourceTree';
import DatasourceVariableTable from '../components/variables/DatasourceVariableTable';
import DatasourcePropertiesPanel from '../components/variables/DatasourcePropertiesPanel';
import { useVariablesDomainStore } from '../store/domains/variablesDomainStore';

export default function VariablesView() {
  const datasources = useVariablesDomainStore((s) => s.datasources);
  const selectedName = useVariablesDomainStore((s) => s.selectedName);
  const selectedConfig = useVariablesDomainStore((s) => s.selectedConfig);
  const setSelectedName = useVariablesDomainStore((s) => s.setSelectedName);
  const loadList = useVariablesDomainStore((s) => s.loadList);
  const loadConfig = useVariablesDomainStore((s) => s.loadConfig);
  const addDatasource = useVariablesDomainStore((s) => s.addDatasource);
  const requestBrowse = useVariablesDomainStore((s) => s.requestBrowse);
  const deleteDatasource = useVariablesDomainStore((s) => s.deleteDatasource);
  const saveSettings = useVariablesDomainStore((s) => s.saveSettings);
  const refreshSelected = useVariablesDomainStore((s) => s.refreshSelected);
  const listError = useVariablesDomainStore((s) => s.listError);
  const configError = useVariablesDomainStore((s) => s.configError);
  const actionError = useVariablesDomainStore((s) => s.actionError);

  useEffect(() => {
    loadList();
    const id = setInterval(loadList, 3000);
    return () => clearInterval(id);
  }, [loadList]);

  // Land on the first datasource rather than three empty panels behind a
  // "select something" message — the list is right there, and the operator
  // came here to look at one. Only fires while nothing is selected, so it
  // never fights a real selection or the 3s list poll.
  useEffect(() => {
    if (!selectedName && datasources.length > 0) setSelectedName(datasources[0].name);
  }, [datasources, selectedName, setSelectedName]);

  useEffect(() => {
    if (selectedName) {
      void loadConfig(selectedName);
    } else {
      useVariablesDomainStore.getState().setSelectedConfig(null);
    }
  }, [selectedName, loadConfig]);

  // ── Handlers ──────────────────────────────────────────────────────────

  const handleBrowseVariables = useCallback(
    (name: string) => {
      setSelectedName(name);
      requestBrowse(name);
    },
    [setSelectedName, requestBrowse],
  );

  const existingNames = datasources.map((d) => d.name);

  // ── Determine connection status for selected datasource ───────────────

  const selectedDs = datasources.find((d) => d.name === selectedName);
  const isConnected = selectedDs?.connected ?? false;
  const statusError = selectedDs?.error ?? null;

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <ConfigLayout
      storageKey="variables"
      left={
        <DatasourceTree
          datasources={datasources}
          selectedName={selectedName}
          existingNames={existingNames}
          onSelect={setSelectedName}
          onAdd={addDatasource}
          onDelete={deleteDatasource}
          onBrowseVariables={handleBrowseVariables}
        />
      }
      center={
        <DatasourceVariableTable
          datasource={selectedConfig}
          onVariablesChange={refreshSelected}
          error={actionError ?? configError ?? listError}
        />
      }
      right={
        <DatasourcePropertiesPanel
          config={selectedConfig}
          connected={isConnected}
          statusError={statusError}
          onSave={saveSettings}
          onStatusChange={loadList}
        />
      }
    />
  );
}
