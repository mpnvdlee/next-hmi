import './panelDiagnosticsBanner.css';
import { useUnownedDiagnostics } from '@config/hooks/usePanelDiagnostics';

/**
 * Findings for the open artifact that belong to no field — a malformed
 * `sections` map, an invalid page id, a component file that wouldn't parse.
 * Nothing in the panel can carry a badge for these, so without a banner they
 * would only ever appear in the header pill's project-wide list.
 */
export default function PanelDiagnosticsBanner() {
  const unowned = useUnownedDiagnostics();
  if (unowned.length === 0) return null;

  const worst = unowned.some((d) => d.severity === 'error') ? 'error' : 'warning';
  return (
    <div className={`cfg-panel-diagnostics cfg-panel-diagnostics--${worst}`} role="status">
      <ul className="cfg-panel-diagnostics__list">
        {unowned.map((d, i) => (
          <li key={`${d.code}:${d.breadcrumb}:${i}`} className="cfg-panel-diagnostics__item">
            <span
              className={`cfg-panel-diagnostics__dot cfg-panel-diagnostics__dot--${d.severity}`}
            />
            <span>
              {d.message}
              {d.breadcrumb && <span className="cfg-panel-diagnostics__where">{d.breadcrumb}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
