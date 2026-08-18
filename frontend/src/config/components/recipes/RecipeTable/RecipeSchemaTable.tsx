import { useState } from 'react';
import type { RecipeDatasetType, RecipeDataType } from '@shared/types/recipe';
import { useRecipeConfigStore } from '@config/store/recipeConfigStore';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { useDeleteConfirm } from '@config/hooks/useDeleteConfirm';
import { EditIcon } from '@config/components/ui/actionIcons';
import { varBindingOf } from '../../editor/bindingPickerUtils';
import PropertySourceBadge from '../../editor/PropertySourceSelector/PropertySourceBadge';
import AddButton from '../../ui/AddButton';
import Button from '../../ui/Button';
import HighlightedInput from '../../ui/HighlightedInput';
import NameInputModal from '../../ui/NameInputModal';
import PanelHeader from '../../ui/PanelHeader';
import SearchHighlight, { SearchHighlightProvider } from '../../ui/SearchHighlight';
import { bindingPath, filterParameters, inferDataType, labelFromPath } from './paramBinding';
import { RecipeLiveCell } from './cells';
import { useRecipePriorityContext } from './liveValues';

interface Props {
  type: RecipeDatasetType;
  filter: string;
  showLive: boolean;
}

/** Parameter definitions of one dataset type — one row per parameter, so a
 *  label, its variable and its type read across rather than out of a drawer. */
export default function RecipeSchemaTable({ type, filter, showLive }: Props) {
  const patchType = useRecipeConfigStore((s) => s.patchType);
  const addParameter = useRecipeConfigStore((s) => s.addParameter);
  const patchParameter = useRecipeConfigStore((s) => s.patchParameter);
  const deleteParameter = useRecipeConfigStore((s) => s.deleteParameter);
  const moveParameter = useRecipeConfigStore((s) => s.moveParameter);
  const deleteType = useRecipeConfigStore((s) => s.deleteType);
  const openBindingPicker = useEditorDomainStore((s) => s.openBindingPicker);

  const [renaming, setRenaming] = useState(false);
  const deleteConfirm = useDeleteConfirm<RecipeDatasetType>({
    message: (t) =>
      `Delete dataset type "${t.name || 'Untitled'}"? All its parameters and datasets will also be deleted.`,
    onConfirm: (t) => deleteType(t.id),
  });

  const rows = filterParameters(type.parameters, filter);
  const columns = showLive ? 6 : 5;

  useRecipePriorityContext(
    type.parameters.map((p) => bindingPath(p.binding)).filter(Boolean),
    showLive,
  );

  /** Open the variable picker (all non-struct variables) and route the pick.
   *  `current` is the parameter's existing binding when rebinding, so the
   *  picker opens on it (absent when adding a new parameter). */
  function pickVariable(
    onPicked: (binding: unknown, dataType: RecipeDataType, path: string) => void,
    current?: unknown,
  ) {
    openBindingPicker('', `recipe-param-${type.id}`, {
      filter: { label: 'Parameter variable' },
      onPick: (binding, meta) => {
        onPicked({ $var: binding }, inferDataType(binding, meta), bindingPath({ $var: binding }));
      },
      currentBinding: varBindingOf(current),
    });
  }

  function onAdd() {
    pickVariable((binding, dataType, path) =>
      addParameter(type.id, { label: labelFromPath(path), binding, dataType }),
    );
  }

  function onRebind(paramId: string) {
    const current = type.parameters.find((p) => p.id === paramId)?.binding;
    pickVariable(
      (binding, dataType) => patchParameter(type.id, paramId, { binding, dataType }),
      current,
    );
  }

  return (
    <SearchHighlightProvider query={filter}>
      <div className="cfg-recipe-panel">
        <PanelHeader
          card
          name={
            <>
              {type.name || 'Untitled'}
              <span className="cfg-recipe-header-id">{type.id}</span>
            </>
          }
          status={
            <span className="cfg-recipe-subline">
              {type.parameters.length} parameters · {type.datasets.length} datasets
            </span>
          }
          actions={
            <>
              <Button size="sm" variant="ghost" onClick={() => setRenaming(true)}>
                Rename
              </Button>
              <Button size="sm" variant="danger" onClick={() => deleteConfirm.ask(type)}>
                Delete
              </Button>
            </>
          }
        />

        <div className="cfg-recipe-toolbar">
          <AddButton title="Add parameter" onClick={onAdd}>
            + Add parameter
          </AddButton>
        </div>

        <div className="cfg-table-wrap">
          <table className="cfg-table cfg-recipe-table">
            <thead>
              <tr>
                <th className="cfg-th cfg-recipe-th--label">Parameter</th>
                <th className="cfg-th">Variable</th>
                <th className="cfg-th cfg-recipe-th--type">Type</th>
                {showLive && <th className="cfg-th cfg-recipe-th--live">Live</th>}
                <th className="cfg-th cfg-recipe-th--move" />
                <th className="cfg-th cfg-th--actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((param) => {
                const index = type.parameters.indexOf(param);
                const path = bindingPath(param.binding);
                // Same finding the backend reports as `recipe-parameter-unbound`:
                // the parameter is carried in every dataset but writes nowhere.
                const unbound = param.binding === undefined;
                return (
                  <tr
                    key={param.id}
                    className={`cfg-row cfg-row--enabled${unbound ? ' cfg-recipe-row--unbound' : ''}`}
                  >
                    <td className="cfg-td">
                      <span className="cfg-recipe-label-cell">
                        {unbound && (
                          <span
                            className="cfg-recipe-warn"
                            title="recipe parameter is not bound to a variable"
                            aria-label="recipe parameter is not bound to a variable"
                          >
                            ⚠
                          </span>
                        )}
                        <HighlightedInput
                          value={param.label}
                          placeholder="Label"
                          onCommit={(text) => patchParameter(type.id, param.id, { label: text })}
                        />
                      </span>
                    </td>
                    <td className="cfg-td">
                      <button
                        type="button"
                        className="cfg-recipe-var-btn"
                        title="Change variable"
                        onClick={() => onRebind(param.id)}
                      >
                        <PropertySourceBadge source="$var" />
                        <span className="cfg-recipe-var-path">
                          {path ? <SearchHighlight text={path} /> : 'Pick a variable…'}
                        </span>
                        <EditIcon />
                      </button>
                    </td>
                    {/* Derived from the bound variable at pick time — stated, not editable. */}
                    <td className="cfg-td cfg-recipe-td--type">
                      <SearchHighlight text={param.dataType} />
                    </td>
                    {showLive && (
                      <td className="cfg-td cfg-recipe-td--live">
                        <RecipeLiveCell path={path} />
                      </td>
                    )}
                    <td className="cfg-td cfg-recipe-td--move">
                      <button
                        type="button"
                        className="cfg-row-action-btn"
                        title="Move up"
                        disabled={index === 0}
                        onClick={() => moveParameter(type.id, param.id, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="cfg-row-action-btn"
                        title="Move down"
                        disabled={index === type.parameters.length - 1}
                        onClick={() => moveParameter(type.id, param.id, 1)}
                      >
                        ↓
                      </button>
                    </td>
                    <td className="cfg-td cfg-recipe-td--actions">
                      <button
                        type="button"
                        className="cfg-delete-btn"
                        title="Remove parameter"
                        onClick={() => deleteParameter(type.id, param.id)}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                );
              })}

              {rows.length === 0 && (
                <tr>
                  <td colSpan={columns} className="cfg-table-empty">
                    {filter
                      ? 'No parameters match the search.'
                      : 'No parameters. Click + Add to pick a variable.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {renaming && (
          <NameInputModal
            title="Rename Dataset Type"
            placeholder="Type name…"
            initialValue={type.name}
            confirmLabel="Rename"
            onConfirm={(name) => {
              patchType(type.id, { name });
              setRenaming(false);
            }}
            onCancel={() => setRenaming(false)}
          />
        )}
        {deleteConfirm.modal}
      </div>
    </SearchHighlightProvider>
  );
}
