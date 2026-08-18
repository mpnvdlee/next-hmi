/**
 * DatasourcePropertiesPanel — right sidebar for the VariablesView.
 *
 * Renders a property editor form based on the selected datasource's type.
 * - OPC-UA Client: server URL, credentials, security, reconnect interval
 * - Static Variables: no connection settings
 * - OPC-UA Test Server: port, endpoint path, start/stop
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useProjectStore } from '@shared/store/projectStore';
import { useVariablesDomainStore } from '@config/store/domains/variablesDomainStore';
import Button from '@config/components/ui/Button';
import PanelHeader from '@config/components/ui/PanelHeader';
import PropertiesEmpty from '@config/components/ui/PropertiesEmpty';
import PropRow from '@config/components/ui/PropRow';
import BoolButtonGroup from '@config/components/ui/BoolButtonGroup';
import Select from '@config/components/ui/Select';
import type {
  DatasourceConfig,
  OpcuaClientSettings,
  TestServerSettings,
} from '@shared/types/datasource';
import { isOpcuaClientSettings, isTestServerSettings } from '@shared/types/datasource';
import { apiJson } from '@shared/utils/api';

interface Props {
  config: DatasourceConfig | null;
  connected: boolean;
  statusError?: string | null;
  onSave: (config: DatasourceConfig) => void | Promise<void>;
  onStatusChange?: () => void;
}

function getDraftFromConfig(config: DatasourceConfig): {
  settings: Record<string, unknown>;
  dirty: boolean;
} {
  const savedDraft = useVariablesDomainStore.getState().propsDrafts[config.name];
  if (savedDraft && typeof savedDraft === 'object') {
    return {
      settings: { ...config.settings, ...savedDraft },
      dirty: true,
    };
  }
  return { settings: { ...config.settings }, dirty: false };
}

export default function DatasourcePropertiesPanel({
  config,
  connected,
  statusError,
  onSave,
  onStatusChange,
}: Props) {
  const setPropsDraft = useVariablesDomainStore((s) => s.setPropsDraft);
  const clearPropsDraft = useVariablesDomainStore((s) => s.clearPropsDraft);

  const [settingsDraft, setSettingsDraft] = useState<Record<string, unknown> | null>(null);
  const [dirty, setDirty] = useState(false);
  const draftRef = useRef<DatasourceConfig | null>(null);
  const dirtyRef = useRef(dirty);
  const configName = config?.name ?? null;
  const draft = config && settingsDraft ? { ...config, settings: { ...settingsDraft } } : null;
  draftRef.current = draft;
  dirtyRef.current = dirty;

  useEffect(() => {
    if (!config) {
      setSettingsDraft(null);
      setDirty(false);
      return;
    }

    const next = getDraftFromConfig(config);
    setSettingsDraft(next.settings);
    setDirty(next.dirty);
    if (next.dirty) {
      useProjectStore.getState().markDirty();
    }
  }, [config]);

  useEffect(() => {
    if (!configName || !settingsDraft) return;
    if (!dirty) {
      clearPropsDraft(configName);
      return;
    }
    setPropsDraft(configName, settingsDraft);
  }, [configName, settingsDraft, dirty, setPropsDraft, clearPropsDraft]);

  const updateSetting = useCallback((key: string, value: unknown) => {
    setSettingsDraft((prev) => {
      if (!prev) return prev;
      return { ...prev, [key]: value };
    });
    setDirty(true);
    useProjectStore.getState().markDirty();
  }, []);

  // Register save callback with projectStore
  useEffect(() => {
    const dsName = configName;
    if (!dsName) return;
    const key = `ds-props-${dsName}`;
    useProjectStore.getState().registerSave(key, async () => {
      if (dirtyRef.current && draftRef.current) {
        await onSave(draftRef.current);
        setDirty(false);
      }
    });
    return () => {
      useProjectStore.getState().unregisterSave(key);
    };
  }, [configName, onSave]);

  if (!config || !draft) {
    return <PropertiesEmpty>Select a datasource to view its properties.</PropertiesEmpty>;
  }

  const settings = draft.settings;

  return (
    <div className="cfg-ds-props">
      <PanelHeader
        kind={config.type}
        name={config.name}
        status={
          <span className="cfg-ds-props__status">
            <span
              className={`cfg-status-dot${
                config.type === 'static'
                  ? ' cfg-status-dot--static'
                  : connected
                    ? ' cfg-status-dot--connected'
                    : statusError
                      ? ' cfg-status-dot--error'
                      : ''
              }`}
            />
            {config.type === 'static'
              ? 'Static (always available)'
              : config.type === 'opcua-test-server'
                ? connected
                  ? 'Running'
                  : statusError
                    ? 'Failed to start'
                    : 'Stopped'
                : connected
                  ? 'Connected'
                  : 'Disconnected'}
          </span>
        }
      />

      {!connected && statusError && (
        <div className="cfg-ds-props__error" role="alert">
          {statusError}
        </div>
      )}

      {/* Controls — above settings */}
      {config.type === 'opcua-test-server' && (
        <div className="cfg-section">
          <div className="cfg-section__title">Control</div>
          <LifecycleButtons
            dsName={config.name}
            connected={connected}
            onStatusChange={onStatusChange}
          />
        </div>
      )}

      {config.type === 'opcua-client' && (
        <div className="cfg-section">
          <div className="cfg-section__title">Control</div>
          <ReconnectButton dsName={config.name} onStatusChange={onStatusChange} />
        </div>
      )}

      {/* Settings — only for OPC-UA types */}
      {config.type !== 'static' && (
        <div className="cfg-section">
          <div className="cfg-section__title">Settings</div>

          {config.type === 'opcua-client' && isOpcuaClientSettings(settings) && (
            <OpcuaClientFields settings={settings} onChange={updateSetting} />
          )}

          {config.type === 'opcua-test-server' && isTestServerSettings(settings) && (
            <TestServerFields settings={settings} onChange={updateSetting} />
          )}
        </div>
      )}
    </div>
  );
}

// ── Sub-forms ────────────────────────────────────────────────────────────────

function OpcuaClientFields({
  settings,
  onChange,
}: {
  settings: OpcuaClientSettings;
  onChange: (key: string, value: unknown) => void;
}) {
  const securityPolicy = settings.security_policy ?? 'NoSecurity';
  const securityMode = settings.security_mode ?? 'SignAndEncrypt';
  const secureEnabled = securityPolicy !== 'NoSecurity';

  const bgEnabled = !(settings.disable_background_sync ?? false);
  return (
    <>
      <PropRow label="Server URL">
        <input
          className="cfg-prop-input"
          type="text"
          value={settings.server_url ?? ''}
          onChange={(e) => onChange('server_url', e.target.value)}
          placeholder="opc.tcp://192.168.1.100:4840"
        />
      </PropRow>
      <PropRow label="Username">
        <input
          className="cfg-prop-input"
          type="text"
          value={settings.username ?? ''}
          onChange={(e) => onChange('username', e.target.value)}
          placeholder="(anonymous)"
        />
      </PropRow>
      <PropRow label="Password">
        <input
          className="cfg-prop-input"
          type="password"
          value={settings.password ?? ''}
          onChange={(e) => onChange('password', e.target.value)}
        />
      </PropRow>
      <PropRow label="Security Policy">
        <Select value={securityPolicy} onChange={(v) => onChange('security_policy', v)}>
          <option value="NoSecurity">No Security</option>
          <option value="Basic256Sha256">Basic256Sha256</option>
          <option value="Aes128Sha256RsaOaep">Aes128Sha256RsaOaep</option>
          <option value="Aes256Sha256RsaPss">Aes256Sha256RsaPss</option>
        </Select>
      </PropRow>
      <PropRow label="Security Mode">
        <Select
          value={securityMode}
          disabled={!secureEnabled}
          onChange={(v) => onChange('security_mode', v)}
        >
          <option value="SignAndEncrypt">SignAndEncrypt</option>
          <option value="Sign">Sign</option>
        </Select>
      </PropRow>
      <PropRow label="Client Certificate">
        <input
          className="cfg-prop-input"
          type="text"
          disabled={!secureEnabled}
          value={settings.client_certificate ?? ''}
          onChange={(e) => onChange('client_certificate', e.target.value)}
          placeholder="certs/client-cert.pem"
        />
      </PropRow>
      <PropRow label="Client Private Key">
        <input
          className="cfg-prop-input"
          type="text"
          disabled={!secureEnabled}
          value={settings.client_private_key ?? ''}
          onChange={(e) => onChange('client_private_key', e.target.value)}
          placeholder="certs/client-key.pem"
        />
      </PropRow>
      <PropRow label="Private Key Password">
        <input
          className="cfg-prop-input"
          type="password"
          disabled={!secureEnabled}
          value={settings.client_private_key_password ?? ''}
          onChange={(e) => onChange('client_private_key_password', e.target.value)}
          placeholder="Optional"
        />
      </PropRow>
      <PropRow label="Server Certificate">
        <input
          className="cfg-prop-input"
          type="text"
          disabled={!secureEnabled}
          value={settings.server_certificate ?? ''}
          onChange={(e) => onChange('server_certificate', e.target.value)}
          placeholder="Optional path to server cert"
        />
      </PropRow>
      <PropRow label="Reconnect (s)">
        <input
          className="cfg-prop-input"
          type="number"
          min={1}
          max={60}
          value={settings.reconnect_interval_s ?? 5}
          onChange={(e) => onChange('reconnect_interval_s', Number(e.target.value))}
        />
      </PropRow>
      <PropRow label="BG Interval (ms)">
        <input
          className="cfg-prop-input"
          type="number"
          min={250}
          max={60000}
          step={100}
          disabled={settings.disable_background_sync ?? false}
          value={settings.bg_publish_interval_ms ?? 1000}
          onChange={(e) => onChange('bg_publish_interval_ms', Number(e.target.value))}
        />
      </PropRow>
      <PropRow label="Fast Publish (ms)">
        <input
          className="cfg-prop-input"
          type="number"
          min={10}
          max={5000}
          step={5}
          value={settings.priority_publish_interval_ms ?? 50}
          onChange={(e) => onChange('priority_publish_interval_ms', Number(e.target.value))}
        />
      </PropRow>
      <PropRow label="Fast Sampling (ms)">
        <input
          className="cfg-prop-input"
          type="number"
          min={0}
          max={5000}
          step={5}
          value={settings.priority_sampling_interval_ms ?? 20}
          onChange={(e) => onChange('priority_sampling_interval_ms', Number(e.target.value))}
        />
      </PropRow>
      <PropRow label="Fast WS Batch (ms)">
        <input
          className="cfg-prop-input"
          type="number"
          min={0}
          max={1000}
          step={5}
          value={settings.priority_ws_batch_ms ?? 10}
          onChange={(e) => onChange('priority_ws_batch_ms', Number(e.target.value))}
        />
      </PropRow>
      <PropRow
        label="Background Sync"
        description="Subscribes every enabled variable on a 5 s cycle, so values are warm before a page asks for them."
      >
        <BoolButtonGroup
          value={bgEnabled}
          onChange={(v) => onChange('disable_background_sync', !v)}
          labels={['On', 'Off']}
        />
      </PropRow>
      <PropRow label="Browse Root Node">
        <input
          className="cfg-prop-input"
          type="text"
          value={settings.browse_root_node ?? ''}
          onChange={(e) => onChange('browse_root_node', e.target.value || undefined)}
          placeholder="e.g. ns=4;s=gPlc (default: Objects)"
        />
      </PropRow>
    </>
  );
}

function TestServerFields({
  settings,
  onChange,
}: {
  settings: TestServerSettings;
  onChange: (key: string, value: unknown) => void;
}) {
  return (
    <>
      <PropRow label="Port">
        <input
          className="cfg-prop-input"
          type="number"
          min={1024}
          max={65535}
          value={settings.port ?? 4855}
          onChange={(e) => onChange('port', Number(e.target.value))}
        />
      </PropRow>
      <PropRow label="Endpoint">
        <input
          className="cfg-prop-input"
          type="text"
          value={settings.endpoint_path ?? '/nexthmi/test/'}
          onChange={(e) => onChange('endpoint_path', e.target.value)}
        />
      </PropRow>
    </>
  );
}

function LifecycleButtons({
  dsName,
  connected,
  onStatusChange,
}: {
  dsName: string;
  connected: boolean;
  onStatusChange?: () => void;
}) {
  type LifecycleAction = 'start' | 'stop' | 'restart';
  const [activeAction, setActiveAction] = useState<LifecycleAction | null>(null);

  async function action(endpoint: LifecycleAction) {
    setActiveAction(endpoint);
    try {
      await apiJson(`/api/datasources/${encodeURIComponent(dsName)}/${endpoint}`, {
        method: 'POST',
      });
      setTimeout(() => {
        onStatusChange?.();
        setActiveAction(null);
      }, 1500);
    } catch (e) {
      console.error('[DatasourcePropertiesPanel] action failed:', e);
      setActiveAction(null);
      // Refresh so the captured start error (e.g. port in use) surfaces.
      onStatusChange?.();
    }
  }

  const busy = activeAction !== null;

  return (
    <div className="cfg-ds-props__btn-group">
      {!connected ? (
        <Button
          variant="success"
          size="sm"
          type="button"
          className="cfg-ds-props__action-btn"
          disabled={busy}
          onClick={() => action('start')}
        >
          {activeAction === 'start' ? 'Starting…' : 'Start'}
        </Button>
      ) : (
        <Button
          variant="danger"
          size="sm"
          type="button"
          className="cfg-ds-props__action-btn"
          disabled={busy}
          onClick={() => action('stop')}
        >
          {activeAction === 'stop' ? 'Stopping…' : 'Stop'}
        </Button>
      )}
      <Button
        variant="neutral"
        size="sm"
        type="button"
        className="cfg-ds-props__action-btn"
        disabled={busy}
        onClick={() => action('restart')}
      >
        {activeAction === 'restart' ? 'Restarting…' : 'Restart'}
      </Button>
    </div>
  );
}

function ReconnectButton({
  dsName,
  onStatusChange,
}: {
  dsName: string;
  onStatusChange?: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function reconnect() {
    setBusy(true);
    try {
      await apiJson(`/api/datasources/${encodeURIComponent(dsName)}/restart`, { method: 'POST' });
      setTimeout(() => {
        onStatusChange?.();
        setBusy(false);
      }, 2000);
    } catch (e) {
      console.error('[DatasourcePropertiesPanel] reconnect failed:', e);
      setBusy(false);
    }
  }

  return (
    <div className="cfg-ds-props__btn-group">
      <Button
        variant="accent"
        size="sm"
        type="button"
        className="cfg-ds-props__action-btn"
        disabled={busy}
        onClick={reconnect}
      >
        {busy ? 'Reconnecting…' : 'Reconnect'}
      </Button>
    </div>
  );
}
