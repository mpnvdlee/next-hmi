import { useState } from 'react';
import type { RecipeDataset, RecipeDatasetType } from '@shared/types/recipe';
import { isArrayDataType } from '@shared/types/recipe';
import { useRecipeConfigStore } from '@config/store/recipeConfigStore';
import Button from '../../ui/Button';
import NameInputModal from '../../ui/NameInputModal';
import PanelHeader from '../../ui/PanelHeader';
import SearchHighlight, { SearchHighlightProvider } from '../../ui/SearchHighlight';
import TextField from '../../ui/TextField';
import ValueCell, { RecipeLiveCell } from './cells';
import { bindingPath, filterParameters } from './paramBinding';
import { useRecipePriorityContext } from './liveValues';

interface DatasetDraft {
  name: string;
  description: string;
  values: Record<string, unknown>;
}

interface Props {
  type: RecipeDatasetType;
  dataset: RecipeDataset;
  filter: string;
  showLive: boolean;
}

/** One saved dataset's values — the type's parameters down the rows, this
 *  dataset's value for each across. */
export default function RecipeValuesTable({ type, dataset, filter, showLive }: Props) {
  const saveDataset = useRecipeConfigStore((s) => s.saveDataset);

  // Local draft — dataset edits never touch the store until "Save dataset".
  // The table is keyed by dataset.id, so a fresh draft mounts per dataset.
  const [draft, setDraft] = useState<DatasetDraft>(() => ({
    name: dataset.name,
    description: dataset.description,
    values: dataset.values,
  }));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [renaming, setRenaming] = useState(false);

  const dirty =
    draft.name !== dataset.name ||
    draft.description !== dataset.description ||
    JSON.stringify(draft.values) !== JSON.stringify(dataset.values);

  const rows = filterParameters(type.parameters, filter);
  const columns = showLive ? 4 : 3;

  useRecipePriorityContext(
    type.parameters.map((p) => bindingPath(p.binding)).filter(Boolean),
    showLive,
  );

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    setSaveError(false);
    try {
      await saveDataset(type.id, dataset.id, {
        name: draft.name,
        description: draft.description,
        values: draft.values,
      });
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  }

  function setValue(paramId: string, v: unknown) {
    setDraft((d) => ({ ...d, values: { ...d.values, [paramId]: v } }));
  }

  return (
    <SearchHighlightProvider query={filter}>
      <div className="cfg-recipe-panel">
        {/* Header strip and description share one card — they are both the
            dataset's own metadata, above its values. */}
        <div className="cfg-recipe-header-card">
          <PanelHeader
            kind={type.name}
            name={
              <>
                {draft.name || 'Untitled'}
                <span className="cfg-recipe-header-id">{dataset.id}</span>
              </>
            }
            status={
              <span className="cfg-recipe-subline">
                {'last loaded '}
                <span>
                  {dataset.loadedAt ? new Date(dataset.loadedAt).toLocaleString() : 'Never'}
                </span>
              </span>
            }
            actions={
              <>
                {saveError ? (
                  <span className="cfg-prop-hint cfg-recipe-hint">Save failed</span>
                ) : (
                  dirty && <span className="cfg-prop-hint cfg-recipe-hint">Unsaved</span>
                )}
                <Button size="sm" variant="ghost" onClick={() => setRenaming(true)}>
                  Rename
                </Button>
                <Button size="sm" variant="primary" disabled={!dirty || saving} onClick={save}>
                  {saving ? 'Saving…' : 'Save dataset'}
                </Button>
              </>
            }
          />

          <div className="cfg-recipe-meta">
            <span className="cfg-recipe-meta__label">Description</span>
            <TextField
              value={draft.description}
              placeholder="What this dataset is for…"
              onCommit={(text) => setDraft((d) => ({ ...d, description: text }))}
            />
          </div>
        </div>

        <div className="cfg-table-wrap">
          <table className="cfg-table cfg-recipe-table cfg-recipe-table--values">
            <thead>
              <tr>
                <th className="cfg-th cfg-recipe-th--label">Parameter</th>
                <th className="cfg-th cfg-recipe-th--type">Type</th>
                <th className="cfg-th">Value</th>
                {showLive && <th className="cfg-th cfg-recipe-th--live">Live</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((param) => (
                <tr
                  key={param.id}
                  className={`cfg-row cfg-row--enabled${
                    isArrayDataType(param.dataType) ? ' cfg-recipe-row--array' : ''
                  }`}
                >
                  <td className="cfg-td">
                    <SearchHighlight text={param.label || 'Untitled parameter'} />
                  </td>
                  <td className="cfg-td cfg-recipe-td--type">
                    <SearchHighlight text={param.dataType} />
                  </td>
                  <td className="cfg-td">
                    <ValueCell
                      param={param}
                      value={draft.values[param.id]}
                      onChange={(v) => setValue(param.id, v)}
                    />
                  </td>
                  {showLive && (
                    <td className="cfg-td cfg-recipe-td--live">
                      <RecipeLiveCell path={bindingPath(param.binding)} />
                    </td>
                  )}
                </tr>
              ))}

              {rows.length === 0 && (
                <tr>
                  <td colSpan={columns} className="cfg-table-empty">
                    {filter
                      ? 'No parameters match the search.'
                      : 'This type has no parameters yet.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {renaming && (
          <NameInputModal
            title="Rename Recipe"
            placeholder="Recipe name…"
            initialValue={draft.name}
            confirmLabel="Rename"
            onConfirm={(name) => {
              setDraft((current) => ({ ...current, name }));
              setRenaming(false);
            }}
            onCancel={() => setRenaming(false)}
          />
        )}
      </div>
    </SearchHighlightProvider>
  );
}
