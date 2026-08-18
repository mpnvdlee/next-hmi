import { useContext, type ReactNode } from 'react';
import { PanelScopeContext, usePanelFieldExpanded } from '@config/store/panelExpansionStore';
import './style.css';

interface Props {
  title: string;
  defaultCollapsed?: boolean;
  children: ReactNode;
}

/** `.cfg-section` with a click-to-collapse header — drop-in for the old static
 *  `<div className="cfg-section__title">` pattern. Open/closed state is
 *  session-scoped (see {@link usePanelFieldExpanded}) so it survives switching
 *  between components and resets on reload. */
export default function CollapsibleSection({ title, defaultCollapsed, children }: Props) {
  const scope = useContext(PanelScopeContext);
  const [stored, setStored] = usePanelFieldExpanded(`${scope}::section::${title}`);
  const expanded = stored ?? !(defaultCollapsed ?? false);
  const collapsed = !expanded;
  return (
    <div className="cfg-section">
      <button
        type="button"
        className="cfg-section__header"
        onClick={() => setStored(collapsed)}
        aria-expanded={!collapsed}
      >
        <span className={`cfg-section__arrow${collapsed ? '' : ' cfg-section__arrow--open'}`}>
          ▶
        </span>
        <span className="cfg-section__title">{title}</span>
      </button>
      {!collapsed && children}
    </div>
  );
}
