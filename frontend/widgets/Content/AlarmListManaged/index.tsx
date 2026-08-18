/* @jsxRuntime classic */
export const schema = {
  title: { type: 'string' as const, label: 'Title', defaultValue: 'Alarms' },
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

export const displayName = 'Alarm List';
export const description = 'Live active alarms, filterable by level, with acknowledgement.';
export const category = 'Content & controls';
export const icon = { type: 'builtin', name: 'warning' } as const;

export default function AlarmListManaged({ properties, layout }: HmiWidgetProps) {
  const active = useActiveAlarms();
  const username = useAlarmUsername();
  const alarmText = useAlarmText();
  const evalCtx = useEvalContext();
  const title = getPropString(properties, 'title', 'Alarms', evalCtx);
  const filterLevel = getPropString(properties, 'filterLevel', '', evalCtx);
  const chrome = getPropBoolean(properties, 'chrome', true, evalCtx);

  const [selectedAlarm, setSelectedAlarm] = useState<AlarmInstance | null>(null);

  const filtered = filterLevel ? active.filter((a) => a.level === filterLevel) : active;

  const handleAck = useCallback(
    async (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      await ackAlarm(id, username);
    },
    [username],
  );

  const handleAckAll = useCallback(async () => {
    await ackAllAlarms(username);
  }, [username]);

  const count = filtered.filter((a) => !a.acked).length;

  return (
    <div
      className={`hmi-component hmi-alarm-surface hmi-alarm-list${chrome ? '' : ' hmi-alarm-surface--flush'}`}
      style={selfLayoutStyle(layout)}
    >
      {/* An empty title means the surrounding card supplies its own header, so
          the band would otherwise be a blank strip carrying a stray count chip. */}
      {title && (
        <div className="hmi-alarm-header hmi-alarm-list__header">
          <span className="hmi-alarm-header__title">{title}</span>
          <span
            className={`hmi-pill hmi-alarm-list__badge${count === 0 ? ' hmi-alarm-list__badge--zero' : ''}`}
          >
            {count}
          </span>
        </div>
      )}

      <div className="hmi-alarm-body">
        {filtered.length === 0 ? (
          <div className="hmi-alarm-empty">No active alarms</div>
        ) : (
          filtered.map((alarm) => (
            <div
              key={alarm.id}
              className={`hmi-alarm-row hmi-alarm-list__row ${alarmLevelClass(alarm.level)}${alarm.acked ? ' hmi-alarm-list__row--acked' : ''}`}
              onClick={() => setSelectedAlarm(alarm)}
            >
              <span className={levelDotClass(alarm.level)} />
              <div className="hmi-alarm-row__content">
                <div className="hmi-alarm-row__title">
                  [{alarm.code}] {alarmText(alarm.title)}
                </div>
                <div className="hmi-alarm-row__meta">
                  {formatAlarmTimeShort(alarm.triggered_at)}
                </div>
              </div>
              {!alarm.acked && (
                <button
                  className="hmi-alarm-btn hmi-alarm-btn--quiet"
                  onClick={(e: React.MouseEvent) => handleAck(e, alarm.id)}
                >
                  ACK
                </button>
              )}
            </div>
          ))
        )}
      </div>

      {filtered.some((a) => !a.acked) && (
        <div className="hmi-alarm-list__footer">
          <button className="hmi-alarm-btn hmi-alarm-btn--primary" onClick={handleAckAll}>
            Acknowledge All
          </button>
        </div>
      )}

      {selectedAlarm && (
        <AlarmDetailDialog
          alarm={selectedAlarm}
          username={username}
          onClose={() => setSelectedAlarm(null)}
        />
      )}
    </div>
  );
}
