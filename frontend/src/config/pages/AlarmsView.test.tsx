import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AlarmsView from './AlarmsView';
import { useAlarmConfigStore } from '../store/alarmConfigStore';
import { useUsersDomainStore } from '../store/domains/usersDomainStore';
import type { AlarmConfig } from '@shared/types/alarm';

vi.mock('../components/alarms/AlarmPropertiesPanel', () => ({
  default: ({ selection }: { selection: { type: string; id: string } | null }) => (
    <div data-testid="properties">{selection ? `${selection.type}:${selection.id}` : 'none'}</div>
  ),
}));
vi.mock('../components/alarms/AlarmPopupPreviewPanel', () => ({
  default: () => <div data-testid="preview" />,
}));

const CONFIG: AlarmConfig = {
  version: 1,
  groups: [
    {
      id: 'tank',
      title: 'Tank',
      alarms: [
        {
          id: 'overflow',
          code: 'A1',
          level: 'error',
          title: 'Overflow',
          description: '',
          image: '',
          auto_popup: false,
          resolutions: [],
          trigger: { type: 'bool', source_value: undefined, min: null, max: null, on_true: true },
          ack_groups: [],
        },
      ],
    },
  ],
};

const INITIAL = useAlarmConfigStore.getState();

beforeEach(() => {
  useAlarmConfigStore.setState({
    config: structuredClone(CONFIG),
    loaded: true,
    selection: null,
    loadError: null,
    load: vi.fn().mockResolvedValue(undefined),
  });
  useUsersDomainStore.setState({ ensureLoaded: vi.fn() });
});

afterEach(() => {
  vi.restoreAllMocks();
  useAlarmConfigStore.setState(INITIAL);
});

describe('AlarmsView', () => {
  it('loads the alarm config and the user groups needed for ack rules', () => {
    const load = vi.fn().mockResolvedValue(undefined);
    const ensureLoaded = vi.fn();
    useAlarmConfigStore.setState({ load });
    useUsersDomainStore.setState({ ensureLoaded });

    render(<AlarmsView />);

    expect(load).toHaveBeenCalledTimes(1);
    expect(ensureLoaded).toHaveBeenCalledTimes(1);
  });

  it('shows a spinner until the config arrives', () => {
    useAlarmConfigStore.setState({ config: null, loaded: false });

    const { container } = render(<AlarmsView />);

    expect(container.querySelector('.app-spinner')).not.toBeNull();
    expect(screen.queryByTestId('properties')).toBeNull();
  });

  it('replaces the workspace with the load error instead of an empty tree', () => {
    useAlarmConfigStore.setState({
      config: null,
      loadError: 'Could not load alarm configuration.',
    });

    render(<AlarmsView />);

    expect(screen.getByText('Could not load alarm configuration.')).toBeInTheDocument();
    expect(screen.queryByTestId('preview')).toBeNull();
  });

  it('renders groups and their alarms in the tree', () => {
    render(<AlarmsView />);

    expect(screen.getByText('Tank')).toBeInTheDocument();
    expect(screen.getByText(/\[A1\] Overflow/)).toBeInTheDocument();
  });

  it('passes the tree selection through to the properties panel', async () => {
    render(<AlarmsView />);

    await userEvent.click(screen.getByText(/\[A1\] Overflow/));

    await waitFor(() =>
      expect(screen.getByTestId('properties')).toHaveTextContent('alarm:overflow'),
    );
  });

  it('lands on the first alarm rather than an empty workspace', async () => {
    render(<AlarmsView />);

    await waitFor(() =>
      expect(screen.getByTestId('properties')).toHaveTextContent('alarm:overflow'),
    );
  });

  it('lands on the group when it has no alarms to land on', async () => {
    useAlarmConfigStore.setState({
      config: { version: 1, groups: [{ id: 'tank', title: 'Tank', alarms: [] }] },
    });

    render(<AlarmsView />);

    await waitFor(() => expect(screen.getByTestId('properties')).toHaveTextContent('group:tank'));
  });

  it('stays empty when there is nothing to select', () => {
    useAlarmConfigStore.setState({ config: { version: 1, groups: [] } });

    render(<AlarmsView />);

    expect(screen.getByTestId('properties')).toHaveTextContent('none');
  });

  it('reflects a group added through the store in the tree', async () => {
    render(<AlarmsView />);

    useAlarmConfigStore.getState().addGroup('Pump');

    expect(await screen.findByText('Pump')).toBeInTheDocument();
  });

  it('drops a deleted alarm from the tree', async () => {
    render(<AlarmsView />);

    useAlarmConfigStore.getState().deleteAlarm('overflow');

    await waitFor(() => expect(screen.queryByText(/\[A1\] Overflow/)).toBeNull());
    expect(screen.getByText('Tank')).toBeInTheDocument();
  });
});
