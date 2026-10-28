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
  rowSize: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Row size',
    defaultValue: 'compact',
    description: 'Touch gives each row and button a tap-sized height and a larger title.',
    options: [
      { label: 'Compact', value: 'compact' },
      { label: 'Touch', value: 'touch' },
    ],
  },
  mark: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Severity mark',
    defaultValue: 'stripe',
    description:
      'How a row shows its level: a stripe on the left, the whole row in the level colour, or only the coloured icon.',
    options: [
      { label: 'Stripe', value: 'stripe' },
      { label: 'Row color', value: 'tint' },
      { label: 'Icon only', value: 'icon' },
    ],
  },
  show: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Show',
    defaultValue: 'active',
    description:
      'Active alarms, cleared ones (History) or both. With Filter chips on, the chips start here.',
    options: [
      { label: 'Active', value: 'active' },
      { label: 'All', value: 'all' },
      { label: 'History', value: 'history' },
    ],
  },
  showFilter: {
    type: 'boolean' as const,
    format: 'show' as const,
    label: 'Filter chips',
    defaultValue: false,
    description: 'All / Active / History chips in the header, so the operator can switch.',
  },
  ackMode: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Acknowledge',
    defaultValue: 'row',
    description: 'Off leaves acknowledging to a Button with the Acknowledge All Alarms action.',
    options: [
      { label: 'Per row', value: 'row' },
      { label: 'Off', value: 'off' },
    ],
  },
  secondLine: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Second line',
    defaultValue: 'time',
    options: [
      { label: 'Time', value: 'time' },
      { label: 'Description and time', value: 'description' },
    ],
  },
};

export const displayName = 'Alarm List';
export const description = 'Live active alarms, filterable by level, with acknowledgement.';
export const category = 'Content & controls';
export const icon = { type: 'builtin', name: 'warning' } as const;

type View = 'all' | 'active' | 'history';

interface ClearedAlarm {
  id: string;
  alarm_id: string;
  code: string;
  level: AlarmLevel;
  title: string;
  description?: string;
  image?: string;
  resolutions?: unknown[];
  group_title?: string;
  values?: unknown[];
  triggered_at: string;
  cleared_at: string;
  acked: boolean;
  acked_by: string;
  acked_at: string;
}

/** The cleared alarms from the history log, refetched when the active list
 *  changes (a clear moves an alarm from one list to the other). */
function useClearedAlarms(enabled: boolean, active: AlarmInstance[]): ClearedAlarm[] {
  const [entries, setEntries] = useState<ClearedAlarm[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = () =>
      apiJson<ClearedAlarm[]>('/api/alarms/history?limit=100')
        .then((data) => {
          if (!cancelled) setEntries((data ?? []).filter((e) => e.cleared_at));
        })
        // Keep the previous rows on a failed poll.
        .catch(() => undefined);
    load();
    const interval = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [enabled, active]);
  return enabled ? entries : [];
}

/** Alarm descriptions by definition id: a history entry carries none of its own. */
function useAlarmDescriptions(enabled: boolean): Record<string, unknown> {
  const [byId, setById] = useState<Record<string, unknown>>({});
  useEffect(() => {
    if (!enabled) return;
    apiJson<{ groups?: { alarms?: { id: string; description?: unknown }[] }[] }>(
      '/api/alarms/config',
    )
      .then((cfg) => {
        const next: Record<string, unknown> = {};
        for (const g of cfg?.groups ?? [])
          for (const a of g.alarms ?? []) next[a.id] = a.description;
        setById(next);
      })
      .catch(() => undefined);
  }, [enabled]);
  return byId;
}

const WARN_PATH = 'M12 3.5l9.5 17h-19z M12 10v4.5 M12 17.5v.5';
const INFO_PATH = 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 11v6 M12 7.5v.5';

function Glyph({ d }: { d: string }) {
  return (
    <svg
      className="hmi-alarm-list__glyph"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

interface Row {
  key: string;
  level: AlarmLevel;
  code: string;
  title: string;
  description: string;
  value: string;
  triggeredAt: string;
  clearedAt: string;
  alarm: AlarmInstance | null;
  state: 'new' | 'acked' | 'active' | 'cleared';
}

const STATE_TEXT = { new: 'New', acked: 'Acked', active: 'Active', cleared: 'Cleared' };

export default function AlarmListManaged({ properties, layout }: HmiWidgetProps) {
  const active = useActiveAlarms();
  const username = useAlarmUsername();
  const alarmText = useAlarmText();
  const evalCtx = useEvalContext();
  const title = getPropString(properties, 'title', 'Alarms', evalCtx);
  const filterLevel = getPropString(properties, 'filterLevel', '', evalCtx);
  const touch = getPropString(properties, 'rowSize', 'compact', evalCtx) === 'touch';
  const mark = getPropString(properties, 'mark', 'stripe', evalCtx);
  const showFilter = getPropBoolean(properties, 'showFilter', false, evalCtx);
  const ackOff = getPropString(properties, 'ackMode', 'row', evalCtx) === 'off';
  const withDescription =
    getPropString(properties, 'secondLine', 'time', evalCtx) === 'description';

  const [selected, setSelected] = useState<{ alarm: AlarmInstance; clearedAt: string } | null>(
    null,
  );
  const shown = getPropString(properties, 'show', 'active', evalCtx);
  const initialView: View = shown === 'all' || shown === 'history' ? shown : 'active';
  const [view, setView] = useState<View>(initialView);
  // A bound Show moves the list along; the chips only change it until then.
  useEffect(() => setView(initialView), [initialView]);
  const showActive = view !== 'history';
  const showCleared = view !== 'active';
  const cleared = useClearedAlarms(showCleared, active);
  const descriptions = useAlarmDescriptions(showCleared && withDescription);

  const byLevel = <T extends { level: AlarmLevel }>(rows: T[]) =>
    filterLevel ? rows.filter((a) => a.level === filterLevel) : rows;
  const filtered = byLevel(active);
  const text = (value: unknown, alarm: AlarmInstance | ClearedAlarm) =>
    withDescription && typeof value === 'string' ? alarmText(value, alarm) : '';
  // The alarm's {1} value: live while active, as it was when it fired once cleared.
  const valueOf = (alarm: AlarmInstance | ClearedAlarm, has: boolean) =>
    touch && has ? alarmText('{1}', alarm) : '';

  const rows: Row[] = [
    ...(showActive ? filtered : []).map((a) => ({
      key: a.id,
      level: a.level,
      code: a.code,
      title: alarmText(a.title, a),
      description: text(a.description, a),
      value: valueOf(a, !!a.value_refs?.length),
      triggeredAt: a.triggered_at,
      clearedAt: '',
      alarm: a,
      state:
        a.ack_required === false
          ? ('active' as const)
          : a.acked
            ? ('acked' as const)
            : ('new' as const),
    })),
    ...(showCleared ? byLevel(cleared) : []).map((e) => ({
      key: `h-${e.id}`,
      level: e.level,
      code: e.code,
      title: alarmText(e.title, e),
      description: text(e.description || descriptions[e.alarm_id], e),
      value: valueOf(e, !!e.values?.length),
      triggeredAt: e.triggered_at,
      clearedAt: e.cleared_at,
      // The detail popup takes an instance; a cleared one carries what history kept.
      alarm: {
        ...e,
        description: e.description || String(descriptions[e.alarm_id] ?? ''),
        image: e.image ?? '',
        resolutions: e.resolutions ?? [],
        group_title: e.group_title ?? '',
        auto_popup: false,
        ack_groups: [],
      },
      state: 'cleared' as const,
    })),
  ];

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

  const chip = (id: View, label: string) => (
    <button
      type="button"
      className="hmi-alarm-list__chip"
      aria-pressed={view === id}
      onClick={() => setView(id)}
    >
      {label}
    </button>
  );

  const ackButton = (r: Row) =>
    r.alarm && r.state === 'new' && !ackOff ? (
      <button
        className="hmi-alarm-btn hmi-alarm-btn--quiet"
        onClick={(e: React.MouseEvent) => handleAck(e, r.alarm!.id)}
      >
        ACK
      </button>
    ) : null;

  const rowClass = (r: Row) =>
    `hmi-alarm-row hmi-alarm-list__row ${alarmLevelClass(r.level)}${r.state === 'acked' ? ' hmi-alarm-list__row--acked' : ''}${r.state === 'cleared' ? ' hmi-alarm-list__row--cleared' : ''}`;
  const open = (r: Row) =>
    r.alarm ? () => setSelected({ alarm: r.alarm!, clearedAt: r.clearedAt }) : undefined;
  const heading = (r: Row) => `${r.code ? `[${r.code}] ` : ''}${r.title}`;

  return (
    <div
      className={`hmi-component hmi-alarm-surface hmi-alarm-surface--flush hmi-alarm-list${touch ? ' hmi-alarm-list--touch' : ''}${mark === 'tint' || mark === 'icon' ? ` hmi-alarm-list--mark-${mark}` : ''}`}
      style={selfLayoutStyle(layout)}
    >
      {/* An empty title means the surrounding card supplies its own header, so
          the band would otherwise be a blank strip carrying a stray count chip. */}
      {(title || showFilter) && (
        <div className="hmi-alarm-header hmi-alarm-list__header">
          {title && <span className="hmi-alarm-header__title">{title}</span>}
          {showFilter ? (
            <div className="hmi-alarm-list__chips" role="group">
              {chip('all', 'All')}
              {chip('active', `Active (${filtered.length})`)}
              {chip('history', 'History')}
            </div>
          ) : (
            <span
              className={`hmi-pill hmi-alarm-list__badge${count === 0 ? ' hmi-alarm-list__badge--zero' : ''}`}
            >
              {count}
            </span>
          )}
        </div>
      )}

      <div className="hmi-alarm-body">
        {rows.length === 0 && (
          <div className="hmi-alarm-empty">
            {view === 'active' ? 'No active alarms' : 'No alarms in this view'}
          </div>
        )}
        {rows.map((r) =>
          touch ? (
            <div key={r.key} className={rowClass(r)} onClick={open(r)}>
              <span className="hmi-alarm-list__level">
                <Glyph d={r.level === 'info' ? INFO_PATH : WARN_PATH} />
              </span>
              <div className="hmi-alarm-row__content">
                <div className="hmi-alarm-row__title">{heading(r)}</div>
                {r.description && <div className="hmi-alarm-list__detail">{r.description}</div>}
              </div>
              <div className="hmi-alarm-list__side">
                {r.value && <div className="hmi-alarm-list__value">{r.value}</div>}
                <div className="hmi-alarm-list__time">
                  {formatAlarmTimeShort(r.triggeredAt)} ·{' '}
                  <span className={`hmi-alarm-list__state hmi-alarm-list__state--${r.state}`}>
                    {STATE_TEXT[r.state]}
                  </span>
                </div>
              </div>
              {ackButton(r)}
            </div>
          ) : (
            <div key={r.key} className={rowClass(r)} onClick={open(r)}>
              <span className={levelDotClass(r.level)} />
              <div className="hmi-alarm-row__content">
                <div className="hmi-alarm-row__title">{heading(r)}</div>
                <div className="hmi-alarm-row__meta">
                  {[
                    r.description,
                    r.clearedAt
                      ? `Cleared ${formatAlarmTimeShort(r.clearedAt)}`
                      : formatAlarmTimeShort(r.triggeredAt),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
              {ackButton(r)}
            </div>
          ),
        )}
      </div>

      {!ackOff && filtered.some((a) => !a.acked) && (
        <div className="hmi-alarm-list__footer">
          <button className="hmi-alarm-btn hmi-alarm-btn--primary" onClick={handleAckAll}>
            Acknowledge All
          </button>
        </div>
      )}

      {selected && (
        <AlarmDetailDialog
          alarm={selected.alarm}
          clearedAt={selected.clearedAt || undefined}
          username={username}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
