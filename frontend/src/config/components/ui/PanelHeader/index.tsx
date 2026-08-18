import type { ReactNode } from 'react';
import './style.css';

interface Props {
  /** What the selected thing is — "alarm group", "Page". Omit where the tree
   *  already says it and the name carries its own qualifier (a recipe's id). */
  kind?: string;
  /**
   * The thing's own name. Omit for a panel whose kind *is* its title (Settings,
   * Global Events) — the kind then renders alone, promoted to the heading style.
   */
  name?: ReactNode;
  /** Widget/component glyph. Turns the header horizontal and puts the name above
   *  the kind, since there the kind is the widget's type, not a category. */
  icon?: ReactNode;
  /** Live-state line under the name — a datasource's connection state. */
  status?: ReactNode;
  /** Header-level actions on the selected thing (Rename, Delete, Save). */
  actions?: ReactNode;
  /**
   * Standalone card for a center-column page, instead of the strip that sits
   * flush at the top of a right-hand properties panel.
   */
  card?: boolean;
}

/** Type-over-name header for whatever a panel currently has selected. */
export default function PanelHeader({ kind, name, icon, status, actions, card }: Props) {
  const cls = [
    'cfg-panel-header',
    icon ? 'cfg-panel-header--with-icon' : '',
    actions ? 'cfg-panel-header--with-actions' : '',
    card ? 'cfg-panel-header--card' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const kindSpan = kind !== undefined && <span className="cfg-panel-header__type">{kind}</span>;
  const nameSpan = <span className="cfg-panel-header__name">{name}</span>;

  return (
    <div className={cls}>
      {icon && (
        <span className="cfg-panel-header__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      {/* A lone kind stays a direct child, so config.css can promote it to the
          heading style — that rule keys off `:only-child`. */}
      {name === undefined ? (
        kindSpan
      ) : (
        <div className="cfg-panel-header__text">
          {icon ? (
            <>
              {nameSpan}
              {kindSpan}
            </>
          ) : (
            <>
              {kindSpan}
              {nameSpan}
              {status}
            </>
          )}
        </div>
      )}
      {actions && <div className="cfg-section-header__actions">{actions}</div>}
    </div>
  );
}
