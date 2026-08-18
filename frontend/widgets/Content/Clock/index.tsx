/* @jsxRuntime classic */
export const schema = {
  format: {
    type: 'string' as const,
    label: 'Format',
    group: 'Content',
    defaultValue: 'HH:mm:ss',
    placeholder: 'HH:mm:ss or YYYY-MM-DD HH:mm',
    description: 'Pattern built from YYYY, MM, DD, HH, mm and ss — or ISO for the full ISO string.',
  },
  timezone: {
    type: 'string' as const,
    label: 'Time zone',
    group: 'Content',
    placeholder: 'Browser time zone (empty) or e.g. UTC',
  },
  value: {
    type: 'string' as const,
    label: 'Value override',
    group: 'Data',
    description: 'Shown instead of the clock whenever it resolves to a non-empty string.',
  },
};

export const description = 'A live clock, formatted with the same patterns as the $time source.';
export const category = 'Content & controls';
export const icon = { type: 'builtin', name: 'clock' } as const;

export default function Clock({ properties, layout }: HmiWidgetProps) {
  const value = usePropString(properties, 'value', '');
  const format = usePropString(properties, 'format', 'HH:mm:ss');
  const timezone = usePropString(properties, 'timezone', '');

  const [, setTick] = useState(0);
  const isLive = !value;

  // The widget owns its ticker. WidgetRenderer subscribes a widget to the
  // shared one-second tick only when `usesTime(node.properties)` is true, and a
  // clock dropped on a page has no properties at all — schema defaults are
  // never materialised into a node — so the shared tick would never reach it.
  // The formatting still goes through the `$time` source below, so patterns and
  // time zones behave exactly as they do everywhere else.
  useEffect(() => {
    if (!isLive) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [isLive]);

  const now = usePropString({ now: { $time: { format, timezone } } }, 'now', '');

  return (
    <span className="hmi-component hmi-clock" style={selfLayoutStyle(layout)}>
      {value || now}
    </span>
  );
}
