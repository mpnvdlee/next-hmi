import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import HistorianConfig from './index';
import { useHistorianConfigStore } from '@config/store/historianConfigStore';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';

const INITIAL = useHistorianConfigStore.getState();

beforeEach(() => {
  useHistorianConfigStore.setState({
    config: { variables: {} },
    status: null,
    availableVars: [],
    load: vi.fn().mockResolvedValue(undefined),
    refreshStatus: vi.fn().mockResolvedValue(undefined),
  });
  useEditorDomainStore.setState({ bindingPickerOpen: false, bindingPickerTarget: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  useHistorianConfigStore.setState(INITIAL);
});

const tracked = (
  key: string,
  over: Partial<{ enabled: boolean; minInterval: number; retention: number }> = {},
) => ({ [key]: { enabled: true, minInterval: 1, retention: 2592000, ...over } });

/** Row for a tracked variable, addressed by its key. */
function varRow(key: string): HTMLElement {
  return screen.getByText(key, { exact: false }).closest('.cfg-field-group') as HTMLElement;
}

/** Open the binding picker via the Add button and return its target. */
async function openPicker() {
  await userEvent.click(screen.getByTitle('Add variable to log'));
  return useEditorDomainStore.getState().bindingPickerTarget!;
}

describe('HistorianConfig', () => {
  it('loads the config on mount and polls the storage status', () => {
    vi.useFakeTimers();
    const load = vi.fn().mockResolvedValue(undefined);
    const refreshStatus = vi.fn().mockResolvedValue(undefined);
    useHistorianConfigStore.setState({ load, refreshStatus });

    const view = render(<HistorianConfig />);
    expect(load).toHaveBeenCalledTimes(1);
    expect(refreshStatus).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10000);
    expect(refreshStatus).toHaveBeenCalledTimes(2);

    view.unmount();
    vi.advanceTimersByTime(10000);
    expect(refreshStatus).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('hides the storage panel until a status snapshot arrives', () => {
    render(<HistorianConfig />);

    expect(screen.queryByText('Storage')).toBeNull();
    expect(screen.getByText('Tracked variables')).toBeInTheDocument();
  });

  it('formats database size, sample count and timestamps', () => {
    useHistorianConfigStore.setState({
      status: {
        dbSizeBytes: 5 * 1024 * 1024,
        variableCount: 3,
        totalSamples: 1234567,
        oldestSample: null,
        newestSample: null,
      },
    });
    render(<HistorianConfig />);

    expect(screen.getByText('5.0 MB')).toBeInTheDocument();
    expect(screen.getByText((1234567).toLocaleString())).toBeInTheDocument();
    expect(screen.getAllByText('None')).toHaveLength(2);
  });

  it('reports an empty database as 0 B', () => {
    useHistorianConfigStore.setState({
      status: {
        dbSizeBytes: 0,
        variableCount: 0,
        totalSamples: 0,
        oldestSample: null,
        newestSample: null,
      },
    });
    render(<HistorianConfig />);

    expect(screen.getByText('0 B')).toBeInTheDocument();
  });

  it('says nothing is logged yet when no variable is tracked', () => {
    render(<HistorianConfig />);

    expect(screen.getByText('No variables are being logged yet.')).toBeInTheDocument();
  });

  it('opens the variable binder filtered to loggable types', async () => {
    render(<HistorianConfig />);

    const target = await openPicker();

    expect(useEditorDomainStore.getState().bindingPickerOpen).toBe(true);
    expect(target.filter).toMatchObject({ type: ['Integer', 'Float', 'Boolean'] });
  });

  it('tracks the picked variable under its composite key', async () => {
    render(<HistorianConfig />);

    const target = await openPicker();
    target.onPick!({ path: 'plc:Tanks/Level' });

    expect(useHistorianConfigStore.getState().config?.variables['plc:Tanks/Level']).toMatchObject({
      enabled: true,
    });
  });

  it('bakes the picked array index into the key', async () => {
    render(<HistorianConfig />);

    const target = await openPicker();
    target.onPick!({ path: 'plc:Tanks/Levels' }, { index: 2 });

    expect(
      useHistorianConfigStore.getState().config?.variables['plc:Tanks/Levels[2]'],
    ).toBeDefined();
  });

  it('keeps the settings of a variable that is picked again', async () => {
    useHistorianConfigStore.setState({
      config: { variables: tracked('plc:Temp', { minInterval: 5 }) },
    });
    render(<HistorianConfig />);

    const target = await openPicker();
    target.onPick!({ path: 'plc:Temp' });

    expect(useHistorianConfigStore.getState().config?.variables['plc:Temp'].minInterval).toBe(5);
  });

  it('shows the sampling interval and retention of a tracked variable', () => {
    useHistorianConfigStore.setState({
      config: { variables: tracked('plc:Temp', { minInterval: 5, retention: 604800 }) },
    });
    render(<HistorianConfig />);

    expect(screen.getByText(/interval: 5s, retention: 7d/)).toBeInTheDocument();
  });

  it('flags a tracked variable that no datasource offers', () => {
    useHistorianConfigStore.setState({
      availableVars: ['plc:Flow'],
      config: { variables: tracked('plc:Gone') },
    });
    render(<HistorianConfig />);

    expect(varRow('plc:Gone')).toHaveClass('cfg-field-group--invalid');
    expect(
      screen.getByTitle(
        "variable 'plc:Gone' is not available on any datasource — it is no longer logged",
      ),
    ).toBeInTheDocument();
  });

  it('does not flag anything while no datasource has reported its variables', () => {
    useHistorianConfigStore.setState({ config: { variables: tracked('plc:Temp') } });
    render(<HistorianConfig />);

    expect(varRow('plc:Temp')).not.toHaveClass('cfg-field-group--invalid');
  });

  it('toggles a tracked variable without removing it', async () => {
    useHistorianConfigStore.setState({ config: { variables: tracked('plc:Temp') } });
    render(<HistorianConfig />);

    await userEvent.click(within(varRow('plc:Temp')).getByTitle('Expand'));
    await userEvent.click(within(varRow('plc:Temp')).getByRole('button', { name: 'Off' }));

    expect(useHistorianConfigStore.getState().config?.variables['plc:Temp'].enabled).toBe(false);
    expect(varRow('plc:Temp')).toBeInTheDocument();
  });

  it('edits the interval and the retention in days', async () => {
    useHistorianConfigStore.setState({ config: { variables: tracked('plc:Temp') } });
    render(<HistorianConfig />);

    await userEvent.click(within(varRow('plc:Temp')).getByTitle('Expand'));
    const [interval, retention] = within(varRow('plc:Temp')).getAllByRole('spinbutton');

    await userEvent.clear(interval);
    await userEvent.type(interval, '10');
    await userEvent.tab();
    await userEvent.clear(retention);
    await userEvent.type(retention, '7');
    await userEvent.tab();

    expect(useHistorianConfigStore.getState().config?.variables['plc:Temp']).toMatchObject({
      minInterval: 10,
      retention: 604800,
    });
  });

  it('removes a tracked variable from the config', async () => {
    useHistorianConfigStore.setState({ config: { variables: tracked('plc:Temp') } });
    render(<HistorianConfig />);

    await userEvent.click(within(varRow('plc:Temp')).getByTitle('Stop tracking'));

    expect(useHistorianConfigStore.getState().config?.variables).toEqual({});
  });
});
