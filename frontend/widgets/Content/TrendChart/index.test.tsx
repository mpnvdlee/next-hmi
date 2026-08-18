import '../../testSdk';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useVariableStore } from '@hmi/store/variableStore';
import { evaluateVisibility } from '@config/utils/visibilityEvaluator';
import type { VisibilityCondition } from '@shared/types/config';
import TrendChart, { schema } from './index';

// A stdlib widget reads the chart library off the SDK global, not from a module
// import, so `vi.mock('recharts')` would never be consulted. Overwrite the
// global instead — the slot `ensureRecharts()` fills in the app. Stubbing rather
// than loading the real library is deliberate: jsdom measures
// ResponsiveContainer at 0×0, so real recharts renders no chart at all and the
// assertions below would have nothing to look at.
(globalThis as Record<string, unknown>).Recharts = {
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LineChart: ({ children, data }: { children: ReactNode; data: unknown[] }) => (
    <div data-testid="line-chart" data-points={data.length}>
      {children}
    </div>
  ),
  Line: ({ dataKey }: { dataKey: string }) => <div data-testid={`line-${dataKey}`} />,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  CartesianGrid: () => null,
  Legend: () => null,
};

function mockFetchOnce(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  });
}

function renderTrendChart(properties: Record<string, unknown>) {
  return render(
    <MemoryRouter>
      <TrendChart properties={properties} />
    </MemoryRouter>,
  );
}

describe('TrendChart', () => {
  beforeEach(() => {
    useVariableStore.setState({ values: {}, varMeta: {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('shows a loading state before the fetch resolves', () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    renderTrendChart({ variables: 'PLC:Temp' });
    expect(screen.getByText('Loading trend data...')).toBeInTheDocument();
  });

  it('prompts for configuration when no variables are set', async () => {
    vi.stubGlobal('fetch', mockFetchOnce({ series: [] }));
    renderTrendChart({});
    await waitFor(() =>
      expect(screen.getByText('Configure variables to display trend data')).toBeInTheDocument(),
    );
  });

  it('shows an empty-data message when the query returns no points', async () => {
    vi.stubGlobal('fetch', mockFetchOnce({ series: [{ variable: 'PLC:Temp', data: [] }] }));
    renderTrendChart({ variables: 'PLC:Temp' });
    await waitFor(() =>
      expect(screen.getByText('No data available for the selected time range')).toBeInTheDocument(),
    );
  });

  it('falls back to the no-data message without crashing when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    renderTrendChart({ variables: 'PLC:Temp' });
    await waitFor(() =>
      expect(screen.getByText('No data available for the selected time range')).toBeInTheDocument(),
    );
  });

  it('falls back to the no-data message on a non-2xx response', async () => {
    vi.stubGlobal('fetch', mockFetchOnce({}, false));
    renderTrendChart({ variables: 'PLC:Temp' });
    await waitFor(() =>
      expect(screen.getByText('No data available for the selected time range')).toBeInTheDocument(),
    );
  });

  it('renders the chart once live series data arrives', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOnce({
        series: [
          {
            variable: 'PLC:Temp',
            data: [
              { t: 1, v: 10 },
              { t: 2, v: 12 },
            ],
          },
        ],
      }),
    );
    renderTrendChart({ variables: 'PLC:Temp' });

    await waitFor(() => expect(screen.getByTestId('line-chart')).toBeInTheDocument());
    expect(screen.getByTestId('line-chart')).toHaveAttribute('data-points', '2');
    expect(screen.getByTestId('line-v0')).toBeInTheDocument();
  });

  it('requests the configured variables and time range from the historian API', async () => {
    const fetchMock = mockFetchOnce({ series: [] });
    vi.stubGlobal('fetch', fetchMock);
    renderTrendChart({ variables: 'PLC:Temp, PLC:Pressure', timeRange: '5m' });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = new URL(fetchMock.mock.calls[0][0], 'http://localhost');
    expect(url.pathname).toBe('/api/historian/query');
    expect(url.searchParams.get('variables')).toBe('PLC:Temp,PLC:Pressure');
  });

  it('polls again after refreshInterval seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = mockFetchOnce({ series: [] });
    vi.stubGlobal('fetch', fetchMock);

    renderTrendChart({ variables: 'PLC:Temp', refreshInterval: 5 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    vi.useRealTimers();
  });

  it('renders range control buttons when showControls is enabled', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOnce({ series: [{ variable: 'PLC:Temp', data: [{ t: 1, v: 10 }] }] }),
    );
    renderTrendChart({ variables: 'PLC:Temp', showControls: true });
    await waitFor(() => expect(screen.getByText('1 hour')).toBeInTheDocument());
    expect(screen.getByText('5 min')).toBeInTheDocument();
  });

  it('carries the component base class on its root element', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOnce({ series: [{ variable: 'PLC:Temp', data: [{ t: 1, v: 10 }] }] }),
    );
    const { container } = renderTrendChart({ variables: 'PLC:Temp' });
    await waitFor(() => expect(screen.getByTestId('line-chart')).toBeInTheDocument());
    // Without `hmi-component` nothing consumes the --self-* custom properties
    // selfLayoutStyle() writes, so every Layout-panel field is silently dead.
    expect(container.firstChild).toHaveClass('hmi-component', 'hmi-trend-chart');
  });

  describe('live mode', () => {
    function renderLive(properties: Record<string, unknown> = {}) {
      return renderTrendChart({ source: 'live', variables: 'PLC:Temp', ...properties });
    }

    it('never queries the historian', () => {
      const fetchMock = mockFetchOnce({ series: [] });
      vi.stubGlobal('fetch', fetchMock);
      renderLive();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('waits with an empty buffer instead of showing a historian message', () => {
      const { container } = renderLive();
      expect(screen.getByText('Waiting for live data...')).toBeInTheDocument();
      expect(container.firstChild).toHaveClass('hmi-component', 'hmi-trend-chart');
    });

    it('still prompts for configuration when no variables are set', () => {
      renderLive({ variables: '' });
      expect(screen.getByText('Configure variables to display trend data')).toBeInTheDocument();
    });

    it('plots the value already in the store and grows as it changes', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      useVariableStore.setState({ values: { 'PLC:Temp': 10 } });
      renderLive();

      expect(screen.getByTestId('line-chart')).toHaveAttribute('data-points', '1');
      expect(screen.getByTestId('line-v0')).toBeInTheDocument();

      act(() => {
        vi.setSystemTime(new Date('2026-01-01T00:00:01Z'));
        useVariableStore.getState().setScalar('PLC:Temp', 12);
      });
      expect(screen.getByTestId('line-chart')).toHaveAttribute('data-points', '2');
    });

    it('buffers one series per configured variable', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      useVariableStore.setState({ values: { 'PLC:Temp': 10, 'PLC:Pressure': 3 } });
      renderLive({ variables: 'PLC:Temp, PLC:Pressure' });

      expect(screen.getByTestId('line-v0')).toBeInTheDocument();
      expect(screen.getByTestId('line-v1')).toBeInTheDocument();
    });

    it('drops the oldest samples once the cap is reached', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      useVariableStore.setState({ values: { 'PLC:Temp': 1 } });
      renderLive({ liveMaxSamples: 2 });

      for (let i = 2; i <= 4; i++) {
        act(() => {
          vi.setSystemTime(new Date(`2026-01-01T00:00:0${i}Z`));
          useVariableStore.getState().setScalar('PLC:Temp', i);
        });
      }
      expect(screen.getByTestId('line-chart')).toHaveAttribute('data-points', '2');
    });

    it('drops samples that fall out of the live window', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      useVariableStore.setState({ values: { 'PLC:Temp': 1 } });
      renderLive({ liveWindow: 10 });

      act(() => {
        vi.setSystemTime(new Date('2026-01-01T00:00:05Z'));
        useVariableStore.getState().setScalar('PLC:Temp', 2);
      });
      expect(screen.getByTestId('line-chart')).toHaveAttribute('data-points', '2');

      act(() => {
        vi.setSystemTime(new Date('2026-01-01T00:00:20Z'));
        useVariableStore.getState().setScalar('PLC:Temp', 3);
      });
      expect(screen.getByTestId('line-chart')).toHaveAttribute('data-points', '1');
    });

    it('ignores non-numeric values', () => {
      useVariableStore.setState({ values: { 'PLC:Temp': 'warming up' } });
      renderLive();
      expect(screen.getByText('Waiting for live data...')).toBeInTheDocument();
    });

    it('hides the historian range buttons even when showControls is stored', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      useVariableStore.setState({ values: { 'PLC:Temp': 10 } });
      renderLive({ showControls: true });
      expect(screen.queryByText('1 hour')).not.toBeInTheDocument();
    });
  });

  describe('mode-gated schema fields', () => {
    const gate = (key: keyof typeof schema) =>
      (schema[key] as { visibleWhen?: VisibilityCondition }).visibleWhen;

    const historyOnly = ['timeRange', 'refreshInterval', 'showControls'] as const;
    const liveOnly = ['liveWindow', 'liveMaxSamples'] as const;

    it.each(historyOnly)('shows %s while source is unset or history', (key) => {
      // The editor evaluates the raw stored property and never applies the
      // schema default, so an unset `source` must still resolve to visible.
      expect(evaluateVisibility(gate(key), {})).toBe(true);
      expect(evaluateVisibility(gate(key), { source: 'history' })).toBe(true);
      expect(evaluateVisibility(gate(key), { source: 'live' })).toBe(false);
    });

    it.each(liveOnly)('shows %s only while source is live', (key) => {
      expect(evaluateVisibility(gate(key), {})).toBe(false);
      expect(evaluateVisibility(gate(key), { source: 'history' })).toBe(false);
      expect(evaluateVisibility(gate(key), { source: 'live' })).toBe(true);
    });

    it.each(['source', 'variables', 'seriesColors'] as const)('leaves %s ungated', (key) => {
      expect(gate(key)).toBeUndefined();
    });
  });
});
