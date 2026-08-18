import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RecipesView from './RecipesView';
import { useRecipeConfigStore } from '../store/recipeConfigStore';
import type { RecipeConfig } from '@shared/types/recipe';

vi.mock('../components/recipes/RecipeTable', () => ({
  default: ({ selection }: { selection: { type: string; id: string } | null }) => (
    <div data-testid="properties">{selection ? `${selection.type}:${selection.id}` : 'none'}</div>
  ),
}));

const CONFIG: RecipeConfig = {
  version: 1,
  datasetTypes: [
    {
      id: 'brew',
      name: 'Brew',
      parameters: [{ id: 'temp', label: 'Temp', binding: undefined, dataType: 'float' }],
      datasets: [
        {
          id: 'espresso',
          name: 'Espresso',
          description: '',
          values: { temp: 92 },
          updatedAt: '',
          updatedBy: '',
          loadedAt: '',
        },
      ],
    },
  ],
};

const INITIAL = useRecipeConfigStore.getState();

beforeEach(() => {
  useRecipeConfigStore.setState({
    config: structuredClone(CONFIG),
    loaded: true,
    selection: null,
    loadError: null,
    load: vi.fn().mockResolvedValue(undefined),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  useRecipeConfigStore.setState(INITIAL);
});

describe('RecipesView', () => {
  it('loads the recipe config on mount', () => {
    const load = vi.fn().mockResolvedValue(undefined);
    useRecipeConfigStore.setState({ load });

    render(<RecipesView />);

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('shows a spinner until the config arrives', () => {
    useRecipeConfigStore.setState({ config: null, loaded: false });

    const { container } = render(<RecipesView />);

    expect(container.querySelector('.app-spinner')).not.toBeNull();
  });

  it('shows the load error in place of the workspace', () => {
    useRecipeConfigStore.setState({
      config: null,
      loadError: 'Could not load recipe configuration.',
    });

    render(<RecipesView />);

    expect(screen.getByText('Could not load recipe configuration.')).toBeInTheDocument();
    expect(screen.queryByTestId('properties')).toBeNull();
  });

  it('renders dataset types with their saved datasets', () => {
    render(<RecipesView />);

    expect(screen.getByText('Brew')).toBeInTheDocument();
    expect(screen.getByText('Espresso')).toBeInTheDocument();
  });

  it('passes a selected dataset through to the properties panel', async () => {
    render(<RecipesView />);

    await userEvent.click(screen.getByText('Espresso'));

    await waitFor(() =>
      expect(screen.getByTestId('properties')).toHaveTextContent('dataset:espresso'),
    );
  });

  it('selects a dataset type from its tree row', async () => {
    render(<RecipesView />);

    await userEvent.click(screen.getByText('Brew'));

    await waitFor(() => expect(screen.getByTestId('properties')).toHaveTextContent('type:brew'));
  });

  it('reflects a type added through the store', async () => {
    render(<RecipesView />);

    useRecipeConfigStore.getState().addType('Grind');

    expect(await screen.findByText('Grind')).toBeInTheDocument();
  });

  it('drops a deleted type and its datasets from the tree', async () => {
    render(<RecipesView />);

    useRecipeConfigStore.getState().deleteType('brew');

    await waitFor(() => expect(screen.queryByText('Brew')).toBeNull());
    expect(screen.queryByText('Espresso')).toBeNull();
  });
});
