import type { RecipeConfig } from '@shared/types/recipe';
import type { RecipeSelection } from '@config/store/recipeConfigStore';
import ConfigPageMessage from '../../ui/ConfigPageMessage';
import RecipeSchemaTable from './RecipeSchemaTable';
import RecipeValuesTable from './RecipeValuesTable';
import './style.css';

interface Props {
  config: RecipeConfig;
  selection: RecipeSelection;
  filter: string;
  showLive: boolean;
}

export default function RecipeTable({ config, selection, filter, showLive }: Props) {
  if (!selection) {
    return <ConfigPageMessage>Select a dataset type or dataset to edit.</ConfigPageMessage>;
  }

  if (selection.type === 'type') {
    const type = config.datasetTypes.find((t) => t.id === selection.id);
    if (!type) return null;
    return <RecipeSchemaTable type={type} filter={filter} showLive={showLive} />;
  }

  const type = config.datasetTypes.find((t) => t.id === selection.typeId);
  const dataset = type?.datasets.find((d) => d.id === selection.id);
  if (!type || !dataset) return null;
  return (
    <RecipeValuesTable
      key={dataset.id}
      type={type}
      dataset={dataset}
      filter={filter}
      showLive={showLive}
    />
  );
}
