import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RecipeTable from './index';
import { useRecipeConfigStore } from '@config/store/recipeConfigStore';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { useVariableStore } from '@hmi/store/variableStore';
import { sendWsMessage } from '@hmi/hooks/useWebSocket';
import type { RecipeConfig } from '@shared/types/recipe';

vi.mock('@hmi/hooks/useWebSocket', () => ({ sendWsMessage: vi.fn() }));

const CONFIG: RecipeConfig = {
  version: 1,
  datasetTypes: [
    {
      id: 'brew',
      name: 'Brew',
      parameters: [
        {
          id: 'temp',
          label: 'Temp',
          binding: { $var: { path: 'plc:Boiler/Temp' } },
          dataType: 'float',
        },
        { id: 'note', label: 'Note', binding: undefined, dataType: 'string' },
      ],
      datasets: [
        {
          id: 'espresso',
          name: 'Espresso',
          description: 'Short shot',
          values: { temp: 92, note: 'ok' },
          updatedAt: '',
          updatedBy: '',
          loadedAt: '',
        },
      ],
    },
  ],
};

const INITIAL = useRecipeConfigStore.getState();

function config(): RecipeConfig {
  return useRecipeConfigStore.getState().config!;
}

/** The table row for a parameter, addressed by its label — an editable input in
 *  the schema table, a stated cell in the values table. */
function paramRow(label: string): HTMLElement {
  const rows = Array.from(document.querySelectorAll<HTMLElement>('.cfg-recipe-table tbody tr'));
  const row = rows.find(
    (r) =>
      r.querySelector<HTMLInputElement>('.cfg-recipe-label-cell input')?.value === label ||
      r.querySelector('td')?.textContent === label,
  );
  if (!row) throw new Error(`no parameter row labelled "${label}"`);
  return row;
}

beforeEach(() => {
  useRecipeConfigStore.setState({ config: structuredClone(CONFIG), loaded: true, loadError: null });
  useEditorDomainStore.setState({ bindingPickerOpen: false, bindingPickerTarget: null });
  vi.mocked(sendWsMessage).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  useRecipeConfigStore.setState(INITIAL);
});

describe('RecipeTable — schema', () => {
  const selection = { type: 'type', id: 'brew' } as const;

  it('names the selected type in the panel header, with its id', () => {
    render(<RecipeTable config={config()} selection={selection} filter="" showLive={false} />);

    expect(screen.getByText('Brew')).toBeInTheDocument();
    expect(screen.getByText('brew')).toBeInTheDocument();
  });

  it('states each parameter with its bound variable and type', () => {
    render(<RecipeTable config={config()} selection={selection} filter="" showLive={false} />);

    const row = paramRow('Temp');
    expect(
      within(row).getByText('plc:Boiler/Temp', { selector: '.cfg-recipe-var-path' }),
    ).toBeInTheDocument();
    expect(within(row).getByText('float')).toBeInTheDocument();
  });

  it('flags a parameter that is bound to no variable', () => {
    render(<RecipeTable config={config()} selection={selection} filter="" showLive={false} />);

    expect(paramRow('Note')).toHaveClass('cfg-recipe-row--unbound');
    expect(screen.getByTitle('recipe parameter is not bound to a variable')).toBeInTheDocument();
  });

  it('renames a parameter in its label cell', async () => {
    render(<RecipeTable config={config()} selection={selection} filter="" showLive={false} />);

    const label = within(paramRow('Temp')).getByDisplayValue('Temp');
    await userEvent.clear(label);
    await userEvent.type(label, 'Boiler temp');
    await userEvent.tab();

    expect(config().datasetTypes[0].parameters[0].label).toBe('Boiler temp');
  });

  it('rebinds a parameter through the variable picker', async () => {
    render(<RecipeTable config={config()} selection={selection} filter="" showLive={false} />);

    await userEvent.click(within(paramRow('Temp')).getByTitle('Change variable'));
    const target = useEditorDomainStore.getState().bindingPickerTarget!;
    target.onPick!({ path: 'plc:Boiler/Setpoint' }, { dataType: 'Integer' });

    expect(config().datasetTypes[0].parameters[0]).toMatchObject({
      binding: { $var: { path: 'plc:Boiler/Setpoint' } },
      dataType: 'integer',
    });
  });

  it('adds a parameter labelled after the picked variable', async () => {
    render(<RecipeTable config={config()} selection={selection} filter="" showLive={false} />);

    await userEvent.click(screen.getByTitle('Add parameter'));
    const target = useEditorDomainStore.getState().bindingPickerTarget!;
    target.onPick!({ path: 'plc:Boiler/Pressure' }, { dataType: 'Float' });

    const params = config().datasetTypes[0].parameters;
    expect(params).toHaveLength(3);
    expect(params[2]).toMatchObject({ label: 'Pressure', dataType: 'float' });
  });

  it('reorders a parameter from its row', async () => {
    render(<RecipeTable config={config()} selection={selection} filter="" showLive={false} />);

    await userEvent.click(within(paramRow('Temp')).getByTitle('Move down'));

    expect(config().datasetTypes[0].parameters.map((p) => p.id)).toEqual(['note', 'temp']);
  });

  it('pins the reorder buttons at the ends of the list', () => {
    render(<RecipeTable config={config()} selection={selection} filter="" showLive={false} />);

    expect(within(paramRow('Temp')).getByTitle('Move up')).toBeDisabled();
    expect(within(paramRow('Note')).getByTitle('Move down')).toBeDisabled();
  });

  it('removes a parameter', async () => {
    render(<RecipeTable config={config()} selection={selection} filter="" showLive={false} />);

    await userEvent.click(within(paramRow('Temp')).getByTitle('Remove parameter'));

    expect(config().datasetTypes[0].parameters.map((p) => p.id)).toEqual(['note']);
  });

  it('keeps only the parameters matching the search', () => {
    render(
      <RecipeTable config={config()} selection={selection} filter="boiler" showLive={false} />,
    );

    expect(screen.getByDisplayValue('Temp')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Note')).toBeNull();
  });

  it('marks the matched text in the rows it keeps', () => {
    render(
      <RecipeTable config={config()} selection={selection} filter="boiler" showLive={false} />,
    );

    const marks = Array.from(document.querySelectorAll('.cfg-search-match')).map(
      (m) => m.textContent,
    );
    // The bound path, and the ghost copy behind the editable label cell.
    expect(marks).toContain('Boiler');
  });

  it('says so when nothing matches the search', () => {
    render(<RecipeTable config={config()} selection={selection} filter="zzz" showLive={false} />);

    expect(screen.getByText('No parameters match the search.')).toBeInTheDocument();
  });

  it('says so when the type has no parameters', () => {
    useRecipeConfigStore.setState({
      config: {
        ...CONFIG,
        datasetTypes: [{ ...CONFIG.datasetTypes[0], parameters: [] }],
      },
    });
    render(<RecipeTable config={config()} selection={selection} filter="" showLive={false} />);

    expect(screen.getByText('No parameters. Click + Add to pick a variable.')).toBeInTheDocument();
  });
});

describe('RecipeTable — dataset values', () => {
  const selection = { type: 'dataset', typeId: 'brew', id: 'espresso' } as const;

  it('states the dataset id and offers its editable fields', () => {
    render(<RecipeTable config={config()} selection={selection} filter="" showLive={false} />);

    expect(screen.getByText('espresso')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Short shot')).toBeInTheDocument();
    expect(screen.getByText('Never')).toBeInTheDocument();
  });

  it('edits a value into the draft and saves it on demand', async () => {
    const saveDataset = vi.fn().mockResolvedValue(undefined);
    useRecipeConfigStore.setState({ saveDataset });
    render(<RecipeTable config={config()} selection={selection} filter="" showLive={false} />);

    const temp = within(paramRow('Temp')).getByDisplayValue('92');
    await userEvent.clear(temp);
    await userEvent.type(temp, '95');
    await userEvent.tab();

    // Nothing is written until the explicit save.
    expect(saveDataset).not.toHaveBeenCalled();
    expect(screen.getByText('Unsaved')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Save dataset' }));

    expect(saveDataset).toHaveBeenCalledWith('brew', 'espresso', {
      name: 'Espresso',
      description: 'Short shot',
      values: { temp: 95, note: 'ok' },
    });
  });

  it('reports a failed save in the header', async () => {
    useRecipeConfigStore.setState({ saveDataset: vi.fn().mockRejectedValue(new Error('nope')) });
    render(<RecipeTable config={config()} selection={selection} filter="" showLive={false} />);

    const description = screen.getByDisplayValue('Short shot');
    await userEvent.clear(description);
    await userEvent.type(description, 'Long shot');
    await userEvent.tab();
    await userEvent.click(screen.getByRole('button', { name: 'Save dataset' }));

    expect(await screen.findByText('Save failed')).toBeInTheDocument();
  });

  it('keeps the save action disabled while nothing is changed', () => {
    render(<RecipeTable config={config()} selection={selection} filter="" showLive={false} />);

    expect(screen.getByRole('button', { name: 'Save dataset' })).toBeDisabled();
  });

  it('edits an array value element by element', async () => {
    useRecipeConfigStore.setState({
      config: {
        ...CONFIG,
        datasetTypes: [
          {
            ...CONFIG.datasetTypes[0],
            parameters: [
              { id: 'steps', label: 'Steps', binding: undefined, dataType: 'integer[]' },
            ],
            datasets: [{ ...CONFIG.datasetTypes[0].datasets[0], values: { steps: [1, 2] } }],
          },
        ],
      },
    });
    const saveDataset = vi.fn().mockResolvedValue(undefined);
    useRecipeConfigStore.setState({ saveDataset });
    render(<RecipeTable config={config()} selection={selection} filter="" showLive={false} />);

    await userEvent.click(screen.getByTitle('Add element'));
    await userEvent.click(screen.getAllByTitle('Remove element')[0]);
    await userEvent.click(screen.getByRole('button', { name: 'Save dataset' }));

    expect(saveDataset).toHaveBeenCalledWith(
      'brew',
      'espresso',
      expect.objectContaining({ values: { steps: [2, 0] } }),
    );
  });
});

describe('RecipeTable — live values', () => {
  beforeEach(() => {
    useVariableStore.setState({ values: { 'plc:Boiler/Temp': 91.5 } });
  });

  afterEach(() => {
    useVariableStore.setState({ values: {} });
  });

  it('shows a bound parameter’s current value in the schema table', () => {
    render(
      <RecipeTable config={config()} selection={{ type: 'type', id: 'brew' }} filter="" showLive />,
    );

    expect(within(paramRow('Temp')).getByText('91.5')).toBeInTheDocument();
    // An unbound parameter has nothing to read.
    expect(within(paramRow('Note')).getByText('—')).toBeInTheDocument();
  });

  it('shows it beside the stored value in the values table', () => {
    render(
      <RecipeTable
        config={config()}
        selection={{ type: 'dataset', typeId: 'brew', id: 'espresso' }}
        filter=""
        showLive
      />,
    );

    const row = paramRow('Temp');
    expect(within(row).getByDisplayValue('92')).toBeInTheDocument();
    expect(within(row).getByText('91.5')).toBeInTheDocument();
  });

  it('asks the backend to prioritise the bound variables, and stops on unmount', () => {
    const { unmount } = render(
      <RecipeTable config={config()} selection={{ type: 'type', id: 'brew' }} filter="" showLive />,
    );

    expect(sendWsMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'set_context', priorityKeys: ['plc:Boiler/Temp'] }),
    );

    unmount();

    expect(sendWsMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'set_context', priorityKeys: [] }),
    );
  });

  it('asks for nothing while the live column is off', () => {
    render(
      <RecipeTable
        config={config()}
        selection={{ type: 'type', id: 'brew' }}
        filter=""
        showLive={false}
      />,
    );

    expect(sendWsMessage).not.toHaveBeenCalled();
  });
});

describe('RecipeTable — no selection', () => {
  it('asks for a selection', () => {
    render(<RecipeTable config={config()} selection={null} filter="" showLive={false} />);

    expect(screen.getByText('Select a dataset type or dataset to edit.')).toBeInTheDocument();
  });
});
