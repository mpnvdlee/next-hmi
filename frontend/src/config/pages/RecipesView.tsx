import { useEffect, useState } from 'react';
import { useTranslations } from '@shared/hooks/useTranslations';
import ConfigLayout from '../components/ui/ConfigLayout';
import Button from '../components/ui/Button';
import HeaderSearch from '../components/ui/HeaderSearch';
import RecipeTree from '../components/recipes/RecipeTree';
import RecipeTable from '../components/recipes/RecipeTable';
import { useRecipeConfigStore } from '../store/recipeConfigStore';
import ConfigWorkspace from '../components/ui/ConfigWorkspace';

export default function RecipesView() {
  useTranslations();
  const [filter, setFilter] = useState('');
  const [showLive, setShowLive] = useState(false);
  const config = useRecipeConfigStore((s) => s.config);
  const selection = useRecipeConfigStore((s) => s.selection);
  const loadError = useRecipeConfigStore((s) => s.loadError);
  const setSelection = useRecipeConfigStore((s) => s.setSelection);
  const load = useRecipeConfigStore((s) => s.load);
  const addType = useRecipeConfigStore((s) => s.addType);
  const addDataset = useRecipeConfigStore((s) => s.addDataset);
  const deleteType = useRecipeConfigStore((s) => s.deleteType);
  const deleteDataset = useRecipeConfigStore((s) => s.deleteDataset);

  useEffect(() => {
    void load();
  }, [load]);

  // Same reason as the other tree views: show the first dataset (or its type,
  // when the type is still empty) instead of an empty workspace.
  useEffect(() => {
    if (selection || !config) return;
    const type = config.datasetTypes[0];
    if (!type) return;
    const dataset = type.datasets[0];
    setSelection(
      dataset
        ? { type: 'dataset', typeId: type.id, id: dataset.id }
        : { type: 'type', id: type.id },
    );
  }, [config, selection, setSelection]);

  if (loadError) {
    return <ConfigWorkspace title="Recipes" loadError={loadError} />;
  }

  if (!config) {
    return <ConfigWorkspace title="Recipes" loading />;
  }

  return (
    <ConfigLayout
      storageKey="recipes"
      left={
        <RecipeTree
          config={config}
          selection={selection}
          onSelect={setSelection}
          onAddType={addType}
          onAddDataset={addDataset}
          onDeleteType={deleteType}
          onDeleteDataset={deleteDataset}
        />
      }
      center={
        <ConfigWorkspace
          title="Recipes"
          actions={
            <>
              <Button
                variant="ghost"
                size="sm"
                className={`cfg-var-live-btn${showLive ? ' cfg-var-live-btn--active' : ''}`}
                onClick={() => setShowLive((on) => !on)}
                aria-pressed={showLive}
              >
                ⚡ Live
              </Button>
              <HeaderSearch
                value={filter}
                onChange={setFilter}
                placeholder="Search parameters…"
                ariaLabel="Search recipe parameters"
              />
            </>
          }
        >
          <RecipeTable config={config} selection={selection} filter={filter} showLive={showLive} />
        </ConfigWorkspace>
      }
    />
  );
}
