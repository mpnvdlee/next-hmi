/* @jsxRuntime classic */
export const schema = {
  source: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Data source',
    group: 'Data',
    description:
      'Recorded queries the historian for stored samples. Live buffers values as they arrive over the connection — no historian needed — and starts empty on every page entry.',
    defaultValue: 'history',
    options: [
      { value: 'history', label: 'Recorded history' },
      { value: 'live', label: 'Live buffer' },
    ],
  },
  variables: {
    type: 'string' as const,
    label: 'Variables',
    group: 'Data',
    description:
      'Comma-separated variable paths, e.g. testserver:Motor1/Speed, testserver:Motor1/Temperature.',
  },
  timeRange: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Default time range',
    group: 'Data',
    defaultValue: '1h',
    // Every mode gate is written against 'live', never against the default
    // 'history': the editor's visibility evaluator reads the raw stored
    // property and knows nothing of schema defaults, so `equals: 'history'`
    // would hide these fields until the author touched the selector.
    visibleWhen: { property: 'source', notEquals: 'live' },
    options: [
      { value: '1m', label: '1 min' },
      { value: '5m', label: '5 min' },
      { value: '15m', label: '15 min' },
      { value: '30m', label: '30 min' },
      { value: '1h', label: '1 hour' },
      { value: '8h', label: '8 hours' },
      { value: '24h', label: '24 hours' },
      { value: '7d', label: '7 days' },
      { value: '30d', label: '30 days' },
    ],
  },
  refreshInterval: {
    type: 'integer' as const,
    label: 'Refresh interval (s)',
    group: 'Data',
    description: 'How often the chart re-queries history. 0 disables polling.',
    defaultValue: 10,
    min: 0,
    max: 3600,
    step: 1,
    visibleWhen: { property: 'source', notEquals: 'live' },
  },
  liveWindow: {
    type: 'integer' as const,
    label: 'Live window (s)',
    group: 'Data',
    description: 'How much recent history the buffer keeps. 0 keeps whatever fits the sample cap.',
    defaultValue: 300,
    min: 0,
    max: 86400,
    step: 10,
    visibleWhen: { property: 'source', equals: 'live' },
  },
  liveMaxSamples: {
    type: 'integer' as const,
    label: 'Max samples per variable',
    group: 'Data',
    description: 'Hard cap on buffered points. The oldest are dropped first.',
    defaultValue: 300,
    min: 10,
    max: 5000,
    step: 10,
    visibleWhen: { property: 'source', equals: 'live' },
  },
  showControls: {
    type: 'boolean' as const,
    format: 'show' as const,
    label: 'Show zoom buttons',
    group: 'Appearance',
    defaultValue: false,
    visibleWhen: { property: 'source', notEquals: 'live' },
  },
  seriesColors: {
    type: 'string' as const,
    label: 'Line colors',
    group: 'Appearance',
    description:
      'Comma-separated colours, one per series. Left empty, the theme series palette is used.',
  },
};

export const displayName = 'Trend Chart';
export const description =
  'Plots recorded tag history over selectable time ranges, or buffers live values with no historian.';
export const category = 'Content & controls';
export const icon = { type: 'builtin', name: 'chart-line' } as const;

// The theme's categorical series palette, in draw order. Held as var()
// references rather than resolved values so a re-themed page repaints the
// traces without the widget re-reading anything.
const COLORS = [
  'var(--hmi-series-1)',
  'var(--hmi-series-2)',
  'var(--hmi-series-3)',
  'var(--hmi-series-4)',
  'var(--hmi-series-5)',
  'var(--hmi-series-6)',
  'var(--hmi-series-7)',
  'var(--hmi-series-8)',
];

const TIME_RANGES: Record<string, { label: string; ms: number }> = {
  '1m': { label: '1 min', ms: 60000 },
  '5m': { label: '5 min', ms: 300000 },
  '15m': { label: '15 min', ms: 900000 },
  '30m': { label: '30 min', ms: 1800000 },
  '1h': { label: '1 hour', ms: 3600000 },
  '8h': { label: '8 hours', ms: 28800000 },
  '24h': { label: '24 hours', ms: 86400000 },
  '7d': { label: '7 days', ms: 604800000 },
  '30d': { label: '30 days', ms: 2592000000 },
};

interface SeriesPoint {
  t: number;
  v: number | null;
}

interface Series {
  variable: string;
  data: SeriesPoint[];
}

type ChartRow = { t: number } & Record<string, number | null>;

const ROOT_CLASS = 'hmi-component hmi-plot-surface hmi-trend-chart';

/**
 * Subscribes to one variable and reports every value it takes.
 *
 * Live mode plots a client-side buffer, and the number of variables is
 * author-controlled — so the subscription cannot be a hook call in the parent's
 * body. One child per key keeps the hook count fixed per component and lets
 * React mount/unmount subscriptions as the list changes.
 */
function LiveSampler({
  varKey,
  onSample,
}: {
  varKey: string;
  onSample: (varKey: string, value: number) => void;
}) {
  const value = useVariable(varKey);
  useEffect(() => {
    const numeric = typeof value === 'boolean' ? Number(value) : value;
    if (typeof numeric === 'number' && Number.isFinite(numeric)) onSample(varKey, numeric);
  }, [varKey, value, onSample]);
  return null;
}

export default function TrendChart({ properties, layout }: HmiWidgetProps) {
  const evalCtx = useEvalContext();
  // .hmi-plot-surface opts this subtree into the suppressed-recharts-outline
  // rule in hmi.css so only chart widgets lose the focus ring, not the app.
  const wrapStyle = selfLayoutStyle(layout);
  const isLive = getPropString(properties, 'source', 'history', evalCtx) === 'live';
  const variablesRaw = getPropString(properties, 'variables', '', evalCtx);
  const variables = useMemo(
    () =>
      variablesRaw
        ? variablesRaw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    [variablesRaw],
  );
  const defaultTimeRange = getPropString(properties, 'timeRange', '1h', evalCtx);
  const refreshInterval = getPropNumber(properties, 'refreshInterval', 10, evalCtx);
  const showControls = !isLive && getPropBoolean(properties, 'showControls', false, evalCtx);
  const liveWindow = getPropNumber(properties, 'liveWindow', 300, evalCtx);
  const liveMaxSamples = getPropNumber(properties, 'liveMaxSamples', 300, evalCtx);

  const [activeRange, setActiveRange] = useState(defaultTimeRange);
  // Follow the configured default when it changes in the editor; the range
  // buttons (when shown) drive activeRange from there.
  useEffect(() => {
    setActiveRange(defaultTimeRange);
  }, [defaultTimeRange]);
  const timeRange = showControls ? activeRange : defaultTimeRange;
  const colorsRaw = getPropString(properties, 'seriesColors', '', evalCtx);
  const colors = useMemo(
    () =>
      colorsRaw
        ? colorsRaw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : COLORS,
    [colorsRaw],
  );

  const [series, setSeries] = useState<Series[]>([]);
  const [loading, setLoading] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  const [liveBuffers, setLiveBuffers] = useState<Record<string, SeriesPoint[]>>({});
  // Trim settings behind a ref so `appendSample` keeps one identity for the
  // whole mount: it is a dependency of every sampler's effect, and a new
  // identity would re-fire them all and duplicate the current value.
  const trimRef = useRef({ windowSec: liveWindow, cap: liveMaxSamples });
  useEffect(() => {
    trimRef.current = { windowSec: liveWindow, cap: liveMaxSamples };
  }, [liveWindow, liveMaxSamples]);

  const appendSample = useCallback((varKey: string, value: number) => {
    // Seconds, matching the historian's point format, so both modes share one
    // merge and one axis.
    const t = Date.now() / 1000;
    const { windowSec, cap } = trimRef.current;
    setLiveBuffers((prev) => {
      let next = (prev[varKey] || []).concat({ t, v: value });
      if (windowSec > 0) {
        const cutoff = t - windowSec;
        next = next.filter((pt) => pt.t >= cutoff);
      }
      if (next.length > cap) next = next.slice(next.length - cap);
      return { ...prev, [varKey]: next };
    });
  }, []);

  useEffect(() => {
    setLiveBuffers((prev) => {
      const keys = Object.keys(prev);
      if (keys.every((key) => variables.includes(key))) return prev;
      const kept: Record<string, SeriesPoint[]> = {};
      for (const key of variables) if (prev[key]) kept[key] = prev[key];
      return kept;
    });
  }, [variables]);

  const liveSeries = useMemo<Series[]>(
    () => variables.map((variable) => ({ variable, data: liveBuffers[variable] || [] })),
    [variables, liveBuffers],
  );

  const fetchData = useCallback(async () => {
    if (!variables.length) {
      setSeries([]);
      setLoading(false);
      return;
    }
    try {
      const rangeMs = TIME_RANGES[timeRange]?.ms || 3600000;
      const start = new Date(Date.now() - rangeMs).toISOString();
      const params = new URLSearchParams({
        variables: variables.join(','),
        start,
        end: 'now',
        maxPoints: '500',
      });
      const resp = await fetch(withBase(`/api/historian/query?${params}`));
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (mountedRef.current) setSeries(data.series || []);
    } catch (err) {
      console.error('[Historian] TrendChart fetch error:', err);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
    // variables.join(',') is the stable identity we actually depend on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variables.join(','), timeRange]);

  useEffect(() => {
    if (isLive) return;
    mountedRef.current = true;
    fetchData();
    if (refreshInterval > 0) {
      intervalRef.current = setInterval(fetchData, refreshInterval * 1000);
    }
    return () => {
      mountedRef.current = false;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchData, refreshInterval, isLive]);

  const activeSeries = isLive ? liveSeries : series;

  const chartData = useMemo<ChartRow[]>(() => {
    if (!activeSeries.length) return [];
    const merged: Record<number, ChartRow> = {};
    activeSeries.forEach((s, i) => {
      (s.data || []).forEach((pt) => {
        const key = Math.round(pt.t * 1000);
        if (!merged[key]) merged[key] = { t: key };
        merged[key][`v${i}`] = pt.v;
      });
    });
    return Object.values(merged).sort((a, b) => a.t - b.t);
  }, [activeSeries]);

  const formatTime = useCallback(
    (ts: number) => {
      const d = new Date(ts);
      // A live buffer spans minutes, not hours: minute resolution would label
      // every tick identically.
      if (isLive) {
        return d.toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
      }
      const rangeMs = TIME_RANGES[timeRange]?.ms || 3600000;
      if (rangeMs <= 86400000) {
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    },
    [timeRange, isLive],
  );

  const tooltipFormatter = useCallback(
    (value: unknown, name: unknown) => {
      const idx = parseInt(String(name).replace('v', ''), 10);
      const label = activeSeries[idx]?.variable || String(name);
      return [typeof value === 'number' ? value.toFixed(2) : String(value), label];
    },
    [activeSeries],
  );

  const legendFormatter = useCallback(
    (value: unknown) => {
      const idx = parseInt(String(value).replace('v', ''), 10);
      return activeSeries[idx]?.variable || String(value);
    },
    [activeSeries],
  );

  // Rendered in the empty branch too — the buffer only fills while its
  // subscriptions are mounted, so dropping them behind a placeholder would
  // leave the chart waiting forever.
  const samplers = isLive
    ? variables.map((variable) =>
        // createElement rather than JSX: the SDK's JSX typing declares no
        // IntrinsicAttributes, so `key` is not accepted as a JSX attribute.
        React.createElement(LiveSampler, {
          key: variable,
          varKey: variable,
          onSample: appendSample,
        }),
      )
    : null;

  if (!isLive && loading) {
    return (
      <div className={ROOT_CLASS} style={wrapStyle}>
        <div className="hmi-trend-chart__placeholder">Loading trend data...</div>
      </div>
    );
  }

  if (!variables.length) {
    return (
      <div className={ROOT_CLASS} style={wrapStyle}>
        <div className="hmi-trend-chart__placeholder">
          Configure variables to display trend data
        </div>
      </div>
    );
  }

  if (!chartData.length) {
    return (
      <div className={ROOT_CLASS} style={wrapStyle}>
        {samplers}
        <div className="hmi-trend-chart__placeholder">
          {isLive ? 'Waiting for live data...' : 'No data available for the selected time range'}
        </div>
      </div>
    );
  }

  return (
    <div className={ROOT_CLASS} style={wrapStyle}>
      {samplers}
      {showControls && (
        <div className="hmi-trend-chart__controls">
          {Object.entries(TIME_RANGES).map(([key, r]) => (
            <button
              key={key}
              className={`hmi-trend-chart__range${activeRange === key ? ' hmi-trend-chart__range--active' : ''}`}
              onClick={() => setActiveRange(key)}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}
      <Recharts.ResponsiveContainer width="100%" height="100%">
        <Recharts.LineChart data={chartData} margin={{ top: 12, right: 16, bottom: 4, left: 0 }}>
          <Recharts.CartesianGrid
            vertical={false}
            strokeDasharray="3 3"
            stroke="var(--hmi-border)"
          />
          <Recharts.XAxis
            dataKey="t"
            tickFormatter={formatTime}
            stroke="none"
            tick={{ fill: 'var(--hmi-text-muted)', fontSize: 'var(--hmi-type-caption-size)' }}
            tickLine={false}
            axisLine={false}
            type="number"
            domain={['dataMin', 'dataMax']}
            scale="time"
            minTickGap={40}
          />
          <Recharts.YAxis
            stroke="none"
            tick={{ fill: 'var(--hmi-text-muted)', fontSize: 'var(--hmi-type-caption-size)' }}
            tickLine={false}
            axisLine={false}
            // Wide enough for a 4-5 digit reading; 40px clipped the leading
            // digit off values like 1400 and rendered them as "400".
            width={56}
            // Recharts defaults to [0, 'auto'], which flattens every process
            // value that lives far from zero — 1200 bph draws as a straight
            // line pinned to the top of the plot. Scale to the data instead.
            domain={['auto', 'auto']}
          />
          <Recharts.Tooltip
            formatter={tooltipFormatter}
            labelFormatter={(ts: unknown) => new Date(ts as number).toLocaleString()}
            contentStyle={{
              background: 'var(--hmi-surface)',
              border: '1px solid var(--hmi-border)',
              borderRadius: 'var(--hmi-radius)',
              fontSize: 'var(--hmi-type-caption-size)',
            }}
          />
          <Recharts.Legend
            formatter={legendFormatter}
            wrapperStyle={{
              fontSize: 'var(--hmi-type-caption-size)',
              paddingTop: 'var(--hmi-space-tight)',
            }}
          />
          {activeSeries.map((s, i) => (
            <Recharts.Line
              key={s.variable}
              type="linear"
              dataKey={`v${i}`}
              stroke={colors[i % colors.length]}
              fill="none"
              strokeWidth={2}
              dot={false}
              activeDot={false}
              legendType="line"
              isAnimationActive={false}
              // Series are merged by exact timestamp, and independently sampled
              // variables almost never share one — so most rows hold a value for
              // a single series and a gap for the rest. Without this each line
              // renders as disconnected fragments instead of a trend.
              connectNulls
            />
          ))}
        </Recharts.LineChart>
      </Recharts.ResponsiveContainer>
    </div>
  );
}
