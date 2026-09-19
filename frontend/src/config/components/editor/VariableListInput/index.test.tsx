import { useState } from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import VariableListInput from './index';
import { useHistorianConfigStore } from '@config/store/historianConfigStore';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';

const INITIAL = useHistorianConfigStore.getState();

// jsdom doesn't implement scrollIntoView; the custom Select's popup calls it.
Element.prototype.scrollIntoView = vi.fn();

const tracked = (...keys: string[]) => ({
  variables: Object.fromEntries(
    keys.map((key) => [key, { enabled: true, minInterval: 1, retention: 2592000 }]),
  ),
});

beforeEach(() => {
  useHistorianConfigStore.setState({
    config: tracked('Brew:Boiler/Temp', 'Brew:Pump/Pressure', 'Brew:Mash/Temp'),
    load: vi.fn().mockResolvedValue(undefined),
    refreshStatus: vi.fn().mockResolvedValue(undefined),
  });
  useEditorDomainStore.setState({ bindingPickerOpen: false, bindingPickerTarget: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  useHistorianConfigStore.setState(INITIAL);
});

/** Controlled, like the properties panel: an edit round-trips through the
 *  stored property, so a row that the owner refuses to keep reverts. */
function renderList(initial: unknown, recordedOnly = true) {
  const onChange = vi.fn();
  function Fixture() {
    const [value, setValue] = useState<unknown>(initial);
    return (
      <VariableListInput
        value={value}
        onChange={(v) => {
          onChange(v);
          setValue(v);
        }}
        label="Variables"
        recordedOnly={recordedOnly}
      />
    );
  }
  render(<Fixture />);
  return onChange;
}

const addBtn = () => screen.getByRole('button', { name: '+ Add' });

describe('VariableListInput', () => {
  it('adds an empty row that is filled in from the row itself', async () => {
    const onChange = renderList('Brew:Boiler/Temp');
    expect(screen.getAllByRole('combobox')).toHaveLength(1);

    await userEvent.click(addBtn());
    const rows = screen.getAllByRole('combobox');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveTextContent('Select variable…');
    // The blank row names nothing, so it is not written to the property yet.
    expect(onChange).not.toHaveBeenCalled();

    await userEvent.click(rows[1]);
    await userEvent.click(screen.getByRole('option', { name: 'Brew:Pump/Pressure' }));
    expect(onChange).toHaveBeenCalledWith('Brew:Boiler/Temp, Brew:Pump/Pressure');
  });

  it('offers every recorded variable except the ones other rows already name', async () => {
    renderList('Brew:Boiler/Temp, Brew:Pump/Pressure');

    await userEvent.click(screen.getAllByRole('combobox')[0]);
    // Its own key stays selectable so the control can show it; the second row's
    // does not, because two series on one key draw the same line twice.
    expect(screen.getByRole('option', { name: 'Brew:Boiler/Temp' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Brew:Mash/Temp' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Brew:Pump/Pressure' })).not.toBeInTheDocument();
  });

  it('keeps and flags a stored variable the historian does not record', () => {
    renderList('Brew:Gone/Tag');

    expect(screen.getByRole('combobox')).toHaveTextContent('Brew:Gone/Tag (not recorded)');
  });

  it('does not call a stored variable unrecorded before the historian config is in hand', () => {
    useHistorianConfigStore.setState({
      config: null,
      load: vi.fn(() => new Promise<void>(() => {})),
    });
    renderList('Brew:Boiler/Temp');

    expect(screen.getByRole('combobox')).toHaveTextContent('Brew:Boiler/Temp');
    expect(screen.getByRole('combobox')).not.toHaveTextContent('(not recorded)');
  });

  it('loads the historian config on demand, and only for a recorded-mode chart', () => {
    const load = vi.fn().mockResolvedValue(undefined);
    useHistorianConfigStore.setState({ config: null, load });

    const { unmount } = render(
      <VariableListInput value="" onChange={vi.fn()} label="Variables" recordedOnly={false} />,
    );
    expect(load).not.toHaveBeenCalled();
    unmount();

    render(<VariableListInput value="" onChange={vi.fn()} label="Variables" recordedOnly />);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('says so when nothing is being recorded yet', () => {
    useHistorianConfigStore.setState({ config: { variables: {} } });
    renderList('');

    expect(screen.getByText(/No variables are being recorded/)).toBeInTheDocument();
  });

  it('opens the whole variable tree for a row added in live mode', async () => {
    const onChange = renderList('', false);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();

    await userEvent.click(addBtn());
    expect(screen.getByText('Select variable…')).toBeInTheDocument();

    // The new row opens on its picker, the way a new $switch case opens expanded.
    const target = useEditorDomainStore.getState().bindingPickerTarget!;
    expect(target.filter?.type).toEqual(['Integer', 'Float', 'Boolean']);

    act(() => target.onPick!({ path: 'Brew:Kettle/Temp' }));
    expect(onChange).toHaveBeenCalledWith('Brew:Kettle/Temp');
    expect(screen.getByText('Brew:Kettle/Temp')).toBeInTheDocument();
  });

  it('bakes an array index into the picked key', async () => {
    const onChange = renderList('', false);
    await userEvent.click(addBtn());

    const target = useEditorDomainStore.getState().bindingPickerTarget!;
    act(() => target.onPick!({ path: 'Brew:Tanks/Level' }, { index: 2 }));
    expect(onChange).toHaveBeenCalledWith('Brew:Tanks/Level[2]');
  });

  it('repoints an existing live row instead of appending', async () => {
    const onChange = renderList('Brew:Kettle/Temp', false);

    await userEvent.click(screen.getByTitle('Select variable'));
    act(() =>
      useEditorDomainStore.getState().bindingPickerTarget!.onPick!({ path: 'Brew:Mash/Temp' }),
    );
    expect(onChange).toHaveBeenCalledWith('Brew:Mash/Temp');
  });

  it('reorders rows, because line colors follow the variable order', async () => {
    const onChange = renderList('Brew:Boiler/Temp, Brew:Pump/Pressure');

    await userEvent.click(screen.getAllByTitle('Move down')[0]);
    expect(onChange).toHaveBeenCalledWith('Brew:Pump/Pressure, Brew:Boiler/Temp');
  });

  it('clears the property when the last row is removed', async () => {
    const onChange = renderList('Brew:Boiler/Temp');

    await userEvent.click(screen.getByTitle('Remove variable'));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });
});
