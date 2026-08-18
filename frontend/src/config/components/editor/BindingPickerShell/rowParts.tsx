/**
 * Shared presentational bits for binding-picker tree rows. Kept separate from
 * any one picker so every picker (variable, component-prop, widget-prop) uses
 * the exact same expand/collapse affordances.
 */

/** Expand/collapse toggle for a row that has children. */
export function ToggleSlot({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      className="cfg-inline-flex-center cfg-icon-reset editor-binding-item__toggle editor-binding-item__toggle--btn"
      onClick={onToggle}
    >
      {open ? '▼' : '▶'}
    </button>
  );
}

/** Fixed-width spacer keeping leaf rows aligned with expandable ones. */
export function EmptyToggleSlot() {
  return <span className="cfg-inline-flex-center editor-binding-item__toggle" />;
}

/**
 * Top-level collapsible group header (a datasource, a component, …) — the
 * outermost row kind in every picker's tree, shared so the datasource list
 * (VariableBindingPicker) and the component list (WidgetPropPicker) render
 * with identical chrome.
 */
export function GroupHeaderRow({
  rowStyle,
  isOpen,
  isLoading,
  name,
  meta,
  metaTruncate,
  onToggle,
}: {
  rowStyle: React.CSSProperties;
  isOpen: boolean;
  isLoading?: boolean;
  name: React.ReactNode;
  meta?: React.ReactNode;
  metaTruncate?: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className="editor-binding-item editor-binding-item--ds"
      style={rowStyle}
      onClick={onToggle}
    >
      <span className="editor-binding-item__toggle">{isOpen ? '▼' : '▶'}</span>
      <span className="editor-binding-item__name">{name}</span>
      {isLoading && <span className="editor-binding-folder__loading">…</span>}
      {meta !== undefined && (
        <span className={`editor-binding-item__meta${metaTruncate ? ' cfg-text-truncate' : ''}`}>
          {meta}
        </span>
      )}
    </div>
  );
}
