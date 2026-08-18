import Button from '../../ui/Button';
import HeaderSearch from '../../ui/HeaderSearch';

interface ToolbarState {
  dsType: string;
  showLive: boolean;
  filter: string;
  browsing: boolean;
}

interface ToolbarActions {
  onToggleLive: () => void;
  onCollapseAll: () => void;
  onExpandAll: () => void;
  onFilterChange: (value: string) => void;
  onBrowse: () => void;
}

interface Props {
  state: ToolbarState;
  actions: ToolbarActions;
}

export default function DatasourceVariableToolbar({ state, actions }: Props) {
  const { dsType, showLive, filter, browsing } = state;
  const { onToggleLive, onCollapseAll, onExpandAll, onFilterChange, onBrowse } = actions;

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

      {dsType !== 'static' && (
        <Button variant="primary" size="sm" onClick={onBrowse} disabled={browsing}>
          {browsing ? 'Browsing…' : 'Browse PLC'}
        </Button>
      )}
    </>
  );
}
