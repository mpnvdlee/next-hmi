/* @jsxRuntime classic */
export const schema = {
  title: { type: 'string' as const, label: 'Title', defaultValue: 'Alarm History' },
  maxRows: {
    type: 'integer' as const,
    label: 'Max rows',
    defaultValue: 100,
    min: 10,
    max: 1000,
    step: 10,
  },
  filterLevel: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Filter level',
    defaultValue: '',
    options: [
      { label: 'All', value: '' },
      { label: 'Error', value: 'error' },
      { label: 'Warning', value: 'warning' },
      { label: 'Info', value: 'info' },
    ],
  },
  chrome: {
    type: 'boolean' as const,
    format: 'show' as const,
    label: 'Own frame',
    defaultValue: true,
    description: 'Turn off when the widget sits inside a card that already draws a frame.',
  },
};

export const displayName = 'Alarm History';
export const description = 'The rolling log of past alarm events.';
export const category = 'Content & controls';
export const icon = { type: 'builtin', name: 'clock-counter-clockwise' } as const;

interface AlarmHistoryEntry {
  id: string;
  code: string;
  level: AlarmLevel;
  title: string;
  triggered_at: string;
  cleared_at: string;
  acked: boolean;
  acked_by: string;
}

export default function AlarmHistoryList({ properties, layout }: HmiWidgetProps) {
  const evalCtx = useEvalContext();
  const title = getPropString(properties, 'title', 'Alarm History', evalCtx);
  const maxRows = getPropNumber(properties, 'maxRows', 100, evalCtx);
  const filterLevel = getPropString(properties, 'filterLevel', '', evalCtx);
  const chrome = getPropBoolean(properties, 'chrome', true, evalCtx);

  // Re-fetch history whenever the active alarm list changes (ack / clear events).
  const activeAlarms = useActiveAlarms();
  const alarmText = useAlarmText();

  const [entries, setEntries] = useState<AlarmHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const params = new URLSearchParams({ limit: String(maxRows) });
        const data = (await apiJson<AlarmHistoryEntry[]>(`/api/alarms/history?${params}`)) ?? [];
        if (!cancelled) {
          setEntries(filterLevel ? data.filter((e) => e.level === filterLevel) : data);
        }
      } catch {
        // keep previous entries on error
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const interval = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [maxRows, filterLevel, activeAlarms]);

  return (
    <div
      className={`hmi-component hmi-alarm-surface hmi-alarm-history${chrome ? '' : ' hmi-alarm-surface--flush'}`}
      style={selfLayoutStyle(layout)}
    >
      {/* An empty title means the surrounding card supplies its own header —
          drawing the band anyway leaves a blank strip above the first row. */}
      {title && (
        <div className="hmi-alarm-header">
          <span className="hmi-alarm-header__title">{title}</span>
        </div>
      )}

      <div className="hmi-alarm-body">
        {loading ? (
          <div className="hmi-alarm-empty">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="hmi-alarm-empty">No alarm history</div>
        ) : (
          entries.map((entry) => (
            <div key={entry.id} className={`hmi-alarm-row ${alarmLevelClass(entry.level)}`}>
              <span className={levelDotClass(entry.level)} />
              <div className="hmi-alarm-row__content">
                <div className="hmi-alarm-row__title">
                  [{entry.code}] {alarmText(entry.title)}
                </div>
                <div className="hmi-alarm-row__meta">
                  {formatAlarmDateTime(entry.triggered_at)} →{' '}
                  {formatAlarmDateTime(entry.cleared_at)}
                </div>
              </div>
              <span
                className={`hmi-alarm-history__ack${entry.acked ? ' hmi-alarm-history__ack--acked' : ''}`}
              >
                {entry.acked ? `ACK: ${entry.acked_by}` : 'Not acked'}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
