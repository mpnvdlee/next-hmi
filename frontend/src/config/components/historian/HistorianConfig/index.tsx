import { useState, useEffect } from 'react';
import { ClearIcon } from '@config/components/ui/actionIcons';
import { useHistorianConfigStore } from '@config/store/historianConfigStore';
import type { VariableConfig } from '@config/store/historianConfigStore';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import type { BindingPickMetadata } from '@config/store/domains/editorDomainStore';
import type { VariableBinding } from '@shared/types/config';
import { bindingParts } from '@shared/types/config';
import AdminSection from '../../admin/AdminSection';
import AddButton from '../../ui/AddButton';
import BoolButtonGroup from '../../ui/BoolButtonGroup';
import FieldGroup from '../../ui/FieldGroup';
import PropRow from '../../ui/PropRow';
import TextField from '../../ui/TextField';
import PropertySourceBadge from '../../editor/PropertySourceSelector/PropertySourceBadge';
import {
  BreakableToken,
  KindLabel,
  PreviewText,
} from '../../editor/PropertySourceEditor/editors/shared';
import './style.css';

// The historian stores every sample as a REAL, so only variables that coerce to
// a number are loggable (see `historian_manager.on_variable_change`).
const LOGGABLE_TYPES = ['Integer', 'Float', 'Boolean'];

const DAY_SECONDS = 86400;
const DEFAULT_RETENTION_SECONDS = 30 * DAY_SECONDS;

// Retention is stored in seconds and edited in days, so the displayed text has
// to survive the round-trip: rounding a sub-day retention to `0` and committing
// it back would set the cutoff to "now" and drop every sample for the variable
// on the next cleanup pass.
function toDayText(seconds: number): string {
  return String(Number((seconds / DAY_SECONDS).toFixed(4)));
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

export default function HistorianConfig() {
  const config = useHistorianConfigStore((s) => s.config);
  const status = useHistorianConfigStore((s) => s.status);
  const availableVars = useHistorianConfigStore((s) => s.availableVars);
  const load = useHistorianConfigStore((s) => s.load);
  const refreshStatus = useHistorianConfigStore((s) => s.refreshStatus);
  const addVariable = useHistorianConfigStore((s) => s.addVariable);
  const removeVariable = useHistorianConfigStore((s) => s.removeVariable);
  const toggleVariable = useHistorianConfigStore((s) => s.toggleVariable);
  const updateVariable = useHistorianConfigStore((s) => s.updateVariable);
  const openBindingPicker = useEditorDomainStore((s) => s.openBindingPicker);

  // The row the user just added opens so its settings are editable straight
  // away; existing rows load collapsed (same rule as an added action).
  const [justAdded, setJustAdded] = useState<string | null>(null);

  useEffect(() => {
    load();
    const timer = setInterval(refreshStatus, 5000);
    return () => clearInterval(timer);
  }, [load, refreshStatus]);

  function openVariablePicker() {
    openBindingPicker('', 'historianVariable', {
      onPick: (binding: VariableBinding, metadata?: BindingPickMetadata) => {
        const { datasource, location } = bindingParts(binding);
        if (!datasource || !location) return;
        // Historian keys are the flat `datasource:path` composite, with an array
        // index already baked into the path — same shape as a write target.
        const key =
          metadata?.index !== undefined
            ? `${datasource}:${location}[${metadata.index}]`
            : `${datasource}:${location}`;
        addVariable(key);
        setJustAdded(key);
      },
      filter: { label: 'Historian variable', type: LOGGABLE_TYPES },
    });
  }

  const varEntries = Object.entries(config?.variables || {});
  // An empty registry means no datasource has reported yet — flagging every row
  // then would be noise, not a finding.
  const canCheckVars = availableVars.length > 0;

  return (
    <>
      {status && (
        <AdminSection title="Storage">
          <div className="cfg-historian-status-grid">
            <span className="cfg-historian-label">Database size</span>
            <span className="cfg-historian-value">{formatBytes(status.dbSizeBytes)}</span>
            <span className="cfg-historian-label">Total samples</span>
            <span className="cfg-historian-value">
              {(status.totalSamples ?? 0).toLocaleString()}
            </span>
            <span className="cfg-historian-label">Variables tracked</span>
            <span className="cfg-historian-value">{status.variableCount ?? 0}</span>
            <span className="cfg-historian-label">Oldest sample</span>
            <span className="cfg-historian-value">
              {status.oldestSample ? new Date(status.oldestSample).toLocaleString() : 'None'}
            </span>
            <span className="cfg-historian-label">Newest sample</span>
            <span className="cfg-historian-value">
              {status.newestSample ? new Date(status.newestSample).toLocaleString() : 'None'}
            </span>
          </div>
        </AdminSection>
      )}

      <AdminSection
        title="Tracked variables"
        actions={<AddButton title="Add variable to log" onClick={openVariablePicker} />}
      >
        {varEntries.length === 0 ? (
          <div className="cfg-prop-hint">No variables are being logged yet.</div>
        ) : (
          <div className="cfg-field-list">
            {varEntries.map(([key, cfg]) => (
              <HistorianVariableRow
                key={key}
                varKey={key}
                cfg={cfg}
                missing={canCheckVars && !availableVars.includes(key)}
                defaultExpanded={key === justAdded}
                onToggle={() => toggleVariable(key)}
                onPatch={(patch) => updateVariable(key, patch)}
                onRemove={() => removeVariable(key)}
              />
            ))}
          </div>
        )}
      </AdminSection>
    </>
  );
}

function HistorianVariableRow({
  varKey,
  cfg,
  missing,
  defaultExpanded,
  onToggle,
  onPatch,
  onRemove,
}: {
  varKey: string;
  cfg: VariableConfig;
  missing: boolean;
  defaultExpanded: boolean;
  onToggle(): void;
  onPatch(patch: Partial<VariableConfig>): void;
  onRemove(): void;
}) {
  const interval = cfg.minInterval ?? 1;
  const intervalText = String(interval);
  const retentionText = toDayText(cfg.retention ?? DEFAULT_RETENTION_SECONDS);

  return (
    <FieldGroup
      tier={3}
      defaultExpanded={defaultExpanded}
      badge={<PropertySourceBadge source="$var" variant="cap" />}
      drawerTitle={varKey}
      kindLabel={<KindLabel>{varKey}</KindLabel>}
      diagnostic={
        missing
          ? {
              level: 'error',
              message: `variable '${varKey}' is not available on any datasource — it is no longer logged`,
            }
          : undefined
      }
      summary={
        <PreviewText>
          <span className={cfg.enabled ? undefined : 'cfg-historian-var-key--disabled'}>
            <BreakableToken text={varKey} />
          </span>
          <span className="cfg-historian-var-meta">
            {' '}
            interval: {intervalText}s, retention: {retentionText}d
          </span>
        </PreviewText>
      }
      actions={
        <button
          type="button"
          className="cfg-row-action-btn cfg-row-action-btn--stretch"
          onClick={onRemove}
          title="Stop tracking"
        >
          <ClearIcon />
        </button>
      }
    >
      <PropRow label="Logging">
        <BoolButtonGroup value={cfg.enabled} onChange={onToggle} labels={['On', 'Off']} />
      </PropRow>
      <PropRow label="Minimum interval" description="Seconds between samples. 0 logs every change.">
        <TextField
          type="number"
          min={0}
          step="any"
          value={intervalText}
          onCommit={(text) => {
            // A blur commits whether or not anything was typed — no-op on an
            // unchanged field rather than write a fresh value every focus.
            if (text.trim() === intervalText) return;
            const next = Number(text);
            if (Number.isFinite(next) && next >= 0) onPatch({ minInterval: next });
          }}
        />
      </PropRow>
      <PropRow label="Retention" description="Days of history kept before samples are dropped.">
        <TextField
          type="number"
          min={0}
          step="any"
          value={retentionText}
          onCommit={(text) => {
            if (text.trim() === retentionText) return;
            const next = Number(text);
            if (Number.isFinite(next) && next >= 0) onPatch({ retention: next * DAY_SECONDS });
          }}
        />
      </PropRow>
    </FieldGroup>
  );
}
