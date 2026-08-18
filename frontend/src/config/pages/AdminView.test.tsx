import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AdminView from './AdminView';
import { useAdminViewStore } from '../store/adminViewStore';

const INITIAL = useAdminViewStore.getState();

function stubLoaders(overrides: Partial<ReturnType<typeof useAdminViewStore.getState>> = {}) {
  useAdminViewStore.setState({
    loadCustomWidgets: vi.fn().mockResolvedValue(undefined),
    loadSubscriptions: vi.fn().mockResolvedValue(undefined),
    loadRuntimes: vi.fn().mockResolvedValue(undefined),
    recompileAllWidgets: vi.fn().mockResolvedValue(undefined),
    recompileWidget: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });
}

function renderView() {
  return render(
    <MemoryRouter>
      <AdminView />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useAdminViewStore.setState({
    customWidgets: [],
    subscriptions: {},
    alarmTriggers: {},
    historianPaths: {},
    runtimes: [],
    runtimesLoading: false,
    runtimesError: null,
    recompiling: [],
    recompileError: null,
  });
  stubLoaders();
});

afterEach(() => {
  vi.restoreAllMocks();
  useAdminViewStore.setState(INITIAL);
});

describe('AdminView', () => {
  it('renders the three admin sections', () => {
    renderView();

    expect(screen.getByText('Fast Subscriptions')).toBeInTheDocument();
    expect(screen.getByText('Custom Widgets')).toBeInTheDocument();
    expect(screen.getByText('Connected Runtimes')).toBeInTheDocument();
  });

  it('reads widgets, subscriptions and runtimes once on mount', () => {
    const loadCustomWidgets = vi.fn().mockResolvedValue(undefined);
    const loadSubscriptions = vi.fn().mockResolvedValue(undefined);
    const loadRuntimes = vi.fn().mockResolvedValue(undefined);
    stubLoaders({ loadCustomWidgets, loadSubscriptions, loadRuntimes });

    renderView();

    expect(loadCustomWidgets).toHaveBeenCalledTimes(1);
    expect(loadSubscriptions).toHaveBeenCalledTimes(1);
    expect(loadRuntimes).toHaveBeenCalledTimes(1);
  });

  it('polls only the subscription snapshot, and stops on unmount', () => {
    vi.useFakeTimers();
    const loadSubscriptions = vi.fn().mockResolvedValue(undefined);
    const loadRuntimes = vi.fn().mockResolvedValue(undefined);
    stubLoaders({ loadSubscriptions, loadRuntimes });

    const view = renderView();
    vi.advanceTimersByTime(4000);
    expect(loadSubscriptions).toHaveBeenCalledTimes(3);
    expect(loadRuntimes).toHaveBeenCalledTimes(1);

    view.unmount();
    vi.advanceTimersByTime(4000);
    expect(loadSubscriptions).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('feeds alarm and historian paths into the subscription section', () => {
    useAdminViewStore.setState({
      subscriptions: {
        plc: {
          priority_paths: ['Temp'],
          priority_leaf_paths: [],
          connected: true,
          bg_enabled: false,
        },
      },
      alarmTriggers: { plc: ['Temp'] },
      historianPaths: { plc: ['Flow'] },
    });
    renderView();

    expect(screen.getByText('2 fast')).toBeInTheDocument();
  });

  it('passes the runtimes error through to its section', () => {
    useAdminViewStore.setState({ runtimesError: 'Error: 503 unreachable' });
    renderView();

    expect(screen.getByText('Error: 503 unreachable')).toBeInTheDocument();
  });
});
