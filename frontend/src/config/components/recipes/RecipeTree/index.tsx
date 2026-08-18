/**
 * RecipeTree — left sidebar for the RecipesView.
 *
 * Expandable dataset types with saved-dataset leaf nodes. Mirrors AlarmTree:
 * shared cfg-tree* classes, useToggleSet for expansion, context-menu delete,
 * NameInputModal for adding a type, and a search bar that filters the tree.
 */

import { useMemo, useState } from 'react';
import { Stack, FileText } from '@phosphor-icons/react';
import type { RecipeConfig } from '@shared/types/recipe';
import type { RecipeSelection } from '@config/store/recipeConfigStore';
import TreeRow from '../../ui/TreeRow';
import TreeSearchBar from '../../ui/TreeSearchBar';
import { ContextMenu, ContextMenuItem } from '../../ui/ContextMenu';
import NameInputModal from '../../ui/NameInputModal';
import { datasetTreeLabel, datasetTypeTreeLabel, filterDatasetTypes } from '../recipeSearch';
import {
  TreeSearchHighlight,
  TreeSearchQueryProvider,
} from '../../editor/WidgetTree/TreeSearchHighlight';
import { withDotSearchSeparators } from '@shared/utils/search';
import { useContextMenu } from '@config/hooks/useContextMenu';
import { useDeleteConfirm } from '@config/hooks/useDeleteConfirm';
import { useToggleSet } from '@shared/hooks/useToggleSet';

interface Props {
  config: RecipeConfig;
  selection: RecipeSelection;
  onSelect(sel: RecipeSelection): void;
  onAddType(name: string): void;
  onAddDataset(typeId: string): void;
  onDeleteType(id: string): void;
  onDeleteDataset(typeId: string, datasetId: string): void;
}

export default function RecipeTree({
  config,
  selection,
  onSelect,
  onAddType,
  onAddDataset,
  onDeleteType,
  onDeleteDataset,
}: Props) {
  const [expandedTypes, toggleType, setExpandedTypes] = useToggleSet<string>(
    config.datasetTypes.map((t) => t.id),
  );
  const [addingType, setAddingType] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const typeMenu = useContextMenu<{ id: string; name: string }>();
  const datasetMenu = useContextMenu<{ typeId: string; id: string; name: string }>();

  type DeleteTarget =
    | { kind: 'type'; id: string; name: string }
    | { kind: 'dataset'; typeId: string; id: string; name: string };
  const deleteConfirm = useDeleteConfirm<DeleteTarget>({
    message: (t) =>
      `Are you sure you want to delete "${t.name}"?${t.kind === 'type' ? ' All its parameters and datasets will also be deleted.' : ''}`,
    onConfirm: (t) => {
      if (t.kind === 'type') onDeleteType(t.id);
      else onDeleteDataset(t.typeId, t.id);
    },
  });

  function isTypeSelected(id: string) {
    return selection?.type === 'type' && selection.id === id;
  }

  function isDatasetSelected(typeId: string, id: string) {
    return selection?.type === 'dataset' && selection.typeId === typeId && selection.id === id;
  }

  const isSearching = searchQuery.trim().length > 0;
  const datasetTypes = useMemo(
    () => filterDatasetTypes(config.datasetTypes, searchQuery),
    [config.datasetTypes, searchQuery],
  );

  return (
    <TreeSearchQueryProvider query={withDotSearchSeparators(searchQuery)}>
      <div className="cfg-tree">
        <TreeSearchBar
          value={searchQuery}
          onChange={setSearchQuery}
          label="Search recipe tree"
          shortcutDisabled={addingType || typeMenu.state !== null || datasetMenu.state !== null}
          onCollapseAll={() => {
            // A search force-expands the tree, so the collapse would be invisible.
            setSearchQuery('');
            setExpandedTypes(new Set());
          }}
        />
        <div className="cfg-tree__scroll">
          {datasetTypes.map((type) => {
            // Search filters the tree down to what matched, so every branch it kept opens.
            const expanded = isSearching || expandedTypes.has(type.id);
            return (
              <div key={type.id}>
                {/* Type row */}
                <TreeRow
                  variant="group"
                  selected={isTypeSelected(type.id)}
                  toggle={{ open: expanded, onClick: () => toggleType(type.id) }}
                  icon={
                    <Stack size={14} className="cfg-tree-item__icon cfg-tree-item__icon--svg" />
                  }
                  label={
                    <span className="cfg-tree-item__label">
                      <TreeSearchHighlight text={datasetTypeTreeLabel(type)} />
                    </span>
                  }
                  onSelect={() => onSelect({ type: 'type', id: type.id })}
                  onContextMenu={(e) => typeMenu.open(e, { id: type.id, name: type.name })}
                >
                  <span className="cfg-tree-item__count">{type.datasets.length}</span>
                </TreeRow>

                {/* Dataset leaves */}
                {expanded && (
                  <>
                    {type.datasets.map((dataset) => (
                      <TreeRow
                        key={dataset.id}
                        depth={1}
                        selected={isDatasetSelected(type.id, dataset.id)}
                        icon={
                          <FileText
                            size={14}
                            className="cfg-tree-item__icon cfg-tree-item__icon--svg"
                          />
                        }
                        label={
                          <span className="cfg-tree-item__label">
                            <TreeSearchHighlight text={datasetTreeLabel(dataset)} />
                          </span>
                        }
                        onSelect={() =>
                          onSelect({ type: 'dataset', typeId: type.id, id: dataset.id })
                        }
                        onContextMenu={(e) =>
                          datasetMenu.open(e, {
                            typeId: type.id,
                            id: dataset.id,
                            name: dataset.name,
                          })
                        }
                      />
                    ))}

                    {type.datasets.length === 0 && (
                      <div className="cfg-tree-section-empty">No datasets yet.</div>
                    )}

                    {/* Add dataset row — hidden while a search narrows the type. */}
                    {!isSearching && (
                      <TreeRow
                        depth={1}
                        dimmed
                        label={<span className="cfg-tree-item__label">+ Add Dataset</span>}
                        onSelect={() => onAddDataset(type.id)}
                      />
                    )}
                  </>
                )}
              </div>
            );
          })}

          {datasetTypes.length === 0 && (
            <div className="cfg-tree-section-empty">
              {isSearching ? 'No datasets match' : 'No dataset types. Add one to get started.'}
            </div>
          )}

          {/* Add type button */}
          {!isSearching && (
            <TreeRow
              variant="group"
              dimmed
              label={<span className="cfg-tree-item__label">+ Add Type</span>}
              onSelect={() => setAddingType(true)}
            />
          )}
        </div>

        {/* Context menus */}
        {typeMenu.state && (
          <ContextMenu x={typeMenu.state.x} y={typeMenu.state.y} onClose={typeMenu.close}>
            <ContextMenuItem
              danger
              onClick={() => {
                deleteConfirm.ask({
                  kind: 'type',
                  id: typeMenu.state!.id,
                  name: typeMenu.state!.name,
                });
                typeMenu.close();
              }}
            >
              Delete "{typeMenu.state.name}"…
            </ContextMenuItem>
          </ContextMenu>
        )}

        {datasetMenu.state && (
          <ContextMenu x={datasetMenu.state.x} y={datasetMenu.state.y} onClose={datasetMenu.close}>
            <ContextMenuItem
              danger
              onClick={() => {
                deleteConfirm.ask({
                  kind: 'dataset',
                  typeId: datasetMenu.state!.typeId,
                  id: datasetMenu.state!.id,
                  name: datasetMenu.state!.name,
                });
                datasetMenu.close();
              }}
            >
              Delete "{datasetMenu.state.name}"…
            </ContextMenuItem>
          </ContextMenu>
        )}

        {/* Modals */}
        {addingType && (
          <NameInputModal
            title="New Dataset Type"
            placeholder="Type name…"
            onConfirm={(name) => {
              onAddType(name);
              setAddingType(false);
            }}
            onCancel={() => setAddingType(false)}
          />
        )}

        {deleteConfirm.modal}
      </div>
    </TreeSearchQueryProvider>
  );
}
