import Button from '../../ui/Button';
import HeaderSearch from '../../ui/HeaderSearch';

interface ToolbarState {
  dsType: string;
  showLive: boolean;
  filter: string;
  browsing: boolean;
  /** Browse PLC is unavailable (a review is pending) without a browse running. */
  browseDisabled?: boolean;
  checking?: boolean;
  /** Check against PLC has saved variables to check. */
  canCheck?: boolean;
  /** ADS: the PLC is shown in the table (browsing). */
  plcShown?: boolean;
  /** ADS: connected, so the PLC can be browsed. */
  connected?: boolean;
}

interface ToolbarActions {
  onToggleLive: () => void;
  onCollapseAll: () => void;
  onExpandAll: () => void;
  onFilterChange: (value: string) => void;
  onBrowse: () => void;
  onCheck?: () => void;
  onTogglePlc?: () => void;
}

interface Props {
  state: ToolbarState;
  actions: ToolbarActions;
}

export default function DatasourceVariableToolbar({ state, actions }: Props) {
  const {
    dsType,
    showLive,
    filter,
    browsing,
    browseDisabled = false,
    checking = false,
    canCheck = true,
    plcShown = false,
    connected = false,
  } = state;
  const {
    onToggleLive,
    onCollapseAll,
    onExpandAll,
    onFilterChange,
    onBrowse,
    onCheck,
    onTogglePlc,
  } = actions;

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        type="button"
        className={`cfg-var-live-btn${showLive ? ' cfg-var-live-btn--active' : ''}`}
        onClick={onToggleLive}
        aria-pressed={showLive}
      >
        ⚡ Live
      </Button>

      <div className="cfg-var-collapse-group cfg-header-control">
        <Button
          variant="icon"
          size="sm"
          type="button"
          className="cfg-var-collapse-btn"
          onClick={onCollapseAll}
          title="Collapse all"
        >
          <span className="cfg-var-collapse-icon cfg-var-collapse-icon--collapse" />
        </Button>
        <Button
          variant="icon"
          size="sm"
          type="button"
          className="cfg-var-collapse-btn"
          onClick={onExpandAll}
          title="Expand all"
        >
          <span className="cfg-var-collapse-icon cfg-var-collapse-icon--expand" />
        </Button>
      </div>

      <HeaderSearch
        value={filter}
        onChange={onFilterChange}
        placeholder="Filter by name, node ID or type…"
        ariaLabel="Filter datasource variables"
      />

      {dsType === 'ads-client' && onCheck && (
        // An icon, like the collapse pair: a text label pushes Browse PLC off
        // the header at 1280 px.
        <Button
          variant="icon"
          size="sm"
          type="button"
          className="cfg-var-check-btn cfg-header-control"
          onClick={onCheck}
          disabled={checking || !canCheck}
          aria-label="Check against PLC"
          title={
            !canCheck
              ? 'Check against PLC: no saved variables to check'
              : checking
                ? 'Checking against the PLC…'
                : 'Check against PLC: mark saved variables the PLC no longer has as stale'
          }
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <rect x="3" y="2.5" width="10" height="11.5" rx="1.5" />
            <path d="M6 2.5V1.75h4v.75" />
            <path d="M5.5 8.5l1.75 1.75L10.5 7" />
          </svg>
        </Button>
      )}

      {dsType === 'ads-client' && onTogglePlc && (
        <Button
          variant={plcShown ? 'neutral' : 'primary'}
          size="sm"
          type="button"
          onClick={onTogglePlc}
          // Stopping always works; browsing needs the PLC.
          disabled={!plcShown && !connected}
          title={
            plcShown
              ? 'Stop showing the PLC in the table'
              : connected
                ? 'Show the PLC in the table: tick a dimmed variable to add it'
                : 'Connect the datasource to browse its PLC'
          }
        >
          {plcShown ? 'Stop browsing' : 'Browse PLC'}
        </Button>
      )}

      {dsType !== 'static' && dsType !== 'ads-client' && (
        <Button
          variant="primary"
          size="sm"
          onClick={onBrowse}
          disabled={browsing || browseDisabled}
        >
          {browsing ? 'Browsing…' : 'Browse PLC'}
        </Button>
      )}
    </>
  );
}
