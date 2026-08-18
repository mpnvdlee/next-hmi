/* @jsxRuntime classic */
export const schema = {
  variable: { type: 'float' as const, label: 'Value', group: 'Data' },
  historyLength: {
    type: 'integer' as const,
    label: 'History length (samples)',
    description: 'How many of the most recent samples the line keeps.',
    group: 'Data',
    min: 10,
    max: 500,
    step: 10,
    defaultValue: 60,
  },
  label: { type: 'string' as const, label: 'Label', group: 'Content' },
  unit: { type: 'string' as const, label: 'Unit', group: 'Content' },
  decimals: {
    type: 'integer' as const,
    label: 'Decimal places',
    group: 'Appearance',
    min: 0,
    max: 6,
    step: 1,
    defaultValue: 1,
  },
  color: {
    type: 'color' as const,
    label: 'Line color',
    defaultToken: '--hmi-accent',
    group: 'Appearance',
  },
};

export const description =
  'A live sparkline of one variable with its current reading — buffered in the page, no historian.';
export const category = 'Indicators';
export const icon = { type: 'builtin', name: 'chart-line' } as const;

interface Sample {
  t: number;
  v: number;
}

// Same guard as ValueDisplay: `decimals` is expression-capable, and toFixed
// throws a RangeError outside 0–100.
function formatValue(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return '---';
  return value.toFixed(Math.min(6, Math.max(0, Math.trunc(decimals))));
}

export default function Trend({ properties, layout }: HmiWidgetProps) {
  const { LineChart, Line, XAxis, YAxis, ResponsiveContainer } = Recharts;

  const rawValue = usePropVar(properties, 'variable');
  const historyLength = usePropNumber(properties, 'historyLength', 60);
  const decimals = usePropNumber(properties, 'decimals', 1);
  const label = usePropString(properties, 'label', '');
  const unit = usePropString(properties, 'unit', '');
  const color = usePropString(properties, 'color', '');
  const accent = useCssVar('--hmi-accent', '#0a84ff');
  const lineColor = color || accent;

  const [history, setHistory] = useState<Sample[]>([]);

  useEffect(() => {
    if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) return;
    setHistory((prev) => {
      const next = [...prev, { t: Date.now(), v: rawValue }];
      const cap = Math.max(2, Math.trunc(historyLength));
      return next.length > cap ? next.slice(next.length - cap) : next;
    });
  }, [rawValue, historyLength]);

  const displayValue = typeof rawValue === 'number' ? formatValue(rawValue, decimals) : '---';

  return (
    <div className="hmi-component hmi-trend" style={selfLayoutStyle(layout)}>
      {label && <span className="hmi-trend__label">{label}</span>}
      <div className="hmi-trend__chart">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={history} margin={{ top: 4, right: 2, bottom: 2, left: 2 }}>
            <XAxis dataKey="t" hide type="number" domain={['dataMin', 'dataMax']} />
            {/* Hidden, but the domain still matters: Recharts defaults to
                [0, 'auto'], which pins a 1,200 bph trace to the top of the plot
                as a flat line. Fit the axis to the data instead. */}
            <YAxis hide domain={['dataMin', 'dataMax']} />
            <Line
              type="monotone"
              dataKey="v"
              stroke={lineColor}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="hmi-trend__readout">
        <span className="hmi-trend__value">{displayValue}</span>
        {unit && <span className="hmi-trend__unit">{unit}</span>}
      </div>
    </div>
  );
}
