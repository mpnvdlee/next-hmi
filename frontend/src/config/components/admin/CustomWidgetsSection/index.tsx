import { Link } from 'react-router-dom';
import { editorPath } from '@shared/utils/runtimeBase';
import AdminSection from '../AdminSection';
import Button from '../../ui/Button';
import { customWidgetKey, type CustomWidgetStatus } from '../../../store/adminViewStore';
import './style.css';

const HMI_VAR_PATTERN = /--hmi-[\w-]+/g;

function hmiVarsInError(error: string): string[] {
  return [...new Set(error.match(HMI_VAR_PATTERN) ?? [])];
}

interface Props {
  widgets: CustomWidgetStatus[];
  recompiling: string[];
  error: string | null;
  onRecompileAll(): void;
  onRecompile(key: string): void;
}

export default function CustomWidgetsSection({
  widgets,
  recompiling,
  error,
  onRecompileAll,
  onRecompile,
}: Props) {
  const recompilingAll = recompiling.includes('*');
  const busy = recompiling.length > 0;

  return (
    <AdminSection
      title="Custom Widgets"
      actions={
        <Button variant="ghost" onClick={onRecompileAll} disabled={busy || widgets.length === 0}>
          {recompilingAll ? 'Recompiling…' : 'Recompile all'}
        </Button>
      }
    >
      {error && <p className="cfg-error-banner">{error}</p>}

      {widgets.length === 0 ? (
        <p className="cfg-empty">
          No custom widgets found in this project's custom-widgets folder.
        </p>
      ) : (
        <table className="cfg-admin-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>CSS</th>
              <th>Compiled</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {widgets.map((w) => {
              const key = customWidgetKey(w);
              const rowBusy = recompiling.includes(key) || recompilingAll;
              return (
                <tr key={key}>
                  <td className="cfg-admin-component-table__name">{key}</td>
                  <td>
                    {w.buildOk === null ? (
                      <span className="cfg-badge cfg-badge--unknown">Unknown</span>
                    ) : !w.buildOk ? (
                      <span className="cfg-badge cfg-badge--error">Error</span>
                    ) : w.schemaError ? (
                      <span className="cfg-badge cfg-badge--unknown">No schema</span>
                    ) : (
                      <span className="cfg-badge cfg-badge--ok">OK</span>
                    )}
                  </td>
                  <td>
                    <span
                      className={`cfg-badge ${w.hasStyle ? 'cfg-badge--ok' : 'cfg-badge--unknown'}`}
                    >
                      {w.hasStyle ? 'Yes' : 'No'}
                    </span>
                  </td>
                  <td className="cfg-admin-component-table__timestamp">
                    {w.buildTs ? new Date(w.buildTs).toLocaleTimeString() : '—'}
                  </td>
                  <td className="cfg-admin-component-table__actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onRecompile(key)}
                      disabled={busy}
                    >
                      {rowBusy ? 'Recompiling…' : 'Recompile'}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {widgets.some((w) => w.buildError || w.schemaError) && (
        <div className="cfg-admin-errors cfg-flex-col">
          {widgets
            .filter((w) => w.buildError || w.schemaError)
            .map((w) => {
              const detail = w.buildError ?? w.schemaError!;
              const hmiVars = hmiVarsInError(detail);
              return (
                <details key={customWidgetKey(w)} className="cfg-admin-error-detail">
                  <summary className="cfg-admin-error-detail__summary">
                    <span className="cfg-badge cfg-badge--error">
                      {w.buildError ? 'Error' : 'No schema'}
                    </span>
                    {customWidgetKey(w)}
                  </summary>
                  {!w.buildError && (
                    <p className="cfg-admin-error-detail__token-hint">
                      This widget renders, but its exports could not be read, so the editor offers
                      no property fields and no exported properties for it.
                    </p>
                  )}
                  <pre className="cfg-admin-error-detail__pre">{detail}</pre>
                  {hmiVars.length > 0 && (
                    <p className="cfg-admin-error-detail__token-hint">
                      This error references HMI token(s):{' '}
                      <code className="cfg-font-mono">{hmiVars.join(', ')}</code>.{' '}
                      <Link to={`${editorPath('/admin')}#theme-tokens`}>
                        Browse available tokens → Admin: Theme Tokens
                      </Link>
                    </p>
                  )}
                </details>
              );
            })}
        </div>
      )}
    </AdminSection>
  );
}
