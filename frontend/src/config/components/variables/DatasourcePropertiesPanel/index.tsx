/**
 * DatasourcePropertiesPanel — right sidebar for the VariablesView.
 *
 * Renders a property editor form based on the selected datasource's type.
 * - OPC-UA Client: server URL, credentials, security, reconnect interval
 * - Static Variables: no connection settings
 * - OPC-UA Test Server: port, endpoint path, network reach, start/stop
 */

import { Fragment, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useProjectStore } from '@shared/store/projectStore';
import { useVariablesDomainStore } from '@config/store/domains/variablesDomainStore';
import Button from '@config/components/ui/Button';
import PanelHeader from '@config/components/ui/PanelHeader';
import PropertiesEmpty from '@config/components/ui/PropertiesEmpty';
import PropRow from '@config/components/ui/PropRow';
import BoolButtonGroup from '@config/components/ui/BoolButtonGroup';
import Select from '@config/components/ui/Select';
import ReadOnlyValue from '@config/components/ui/ReadOnlyValue';
import CertificateControls from '../CertificateControls';
import ServerCertificateCard from '../CertificateControls/ServerCertificateCard';
import type {
  DatasourceConfig,
  OpcuaClientSettings,
  ServerCertificateStatus,
  TestServerSettings,
  TreeNode,
} from '@shared/types/datasource';
import { isFolder, isOpcuaClientSettings, isTestServerSettings } from '@shared/types/datasource';
import { apiJson } from '@shared/utils/api';

interface Props {
  config: DatasourceConfig | null;
  connected: boolean;
  statusError?: string | null;
  /** Whether the secured endpoint's certificate is the pinned one. */
  certificateStatus?: ServerCertificateStatus | null;
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
  certificateStatus = null,
  onSave,
  onStatusChange,
}: Props) {
  const setPropsDraft = useVariablesDomainStore((s) => s.setPropsDraft);
  const clearPropsDraft = useVariablesDomainStore((s) => s.clearPropsDraft);
  const pinServerCertificate = useVariablesDomainStore((s) => s.pinServerCertificate);

  const [settingsDraft, setSettingsDraft] = useState<Record<string, unknown> | null>(null);
  const [dirty, setDirty] = useState(false);
  // Suppress a stale error while a user-triggered connect/disconnect is in
  // flight — the old message is meaningless once the engine has been swapped.
  const [connBusy, setConnBusy] = useState(false);
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
  const effectiveError = connBusy ? null : statusError;
  const signsIn = isOpcuaClientSettings(config.settings) && !!config.settings.username;
  // The trust card below is where a connection held for its certificate says
  // so; the engine's refusal in the header would repeat it.
  const heldForCertificate =
    config.type === 'opcua-client' &&
    (certificateStatus === 'changed' || (certificateStatus === 'untrusted' && signsIn));

  return (
    <div className="cfg-ds-props">
      <PanelHeader
        kind={config.type}
        name={config.name}
        status={
          <>
            <span className="cfg-ds-props__status">
              <span
                className={`cfg-status-dot${
                  config.type === 'static'
                    ? ' cfg-status-dot--static'
                    : connected
                      ? ' cfg-status-dot--connected'
                      : effectiveError
                        ? ' cfg-status-dot--error'
                        : ''
                }`}
              />
              {config.type === 'static'
                ? 'Static (always available)'
                : config.type === 'opcua-test-server'
                  ? connected
                    ? 'Running'
                    : effectiveError
                      ? 'Failed to start'
                      : 'Stopped'
                  : connected
                    ? 'Connected'
                    : 'Disconnected'}
            </span>
            {!connected && effectiveError && !heldForCertificate && (
              <span className="cfg-ds-props__error" role="alert">
                {effectiveError}
              </span>
            )}
          </>
        }
      />

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
          <ConnectionButtons
            dsName={config.name}
            connected={connected}
            onBusyChange={setConnBusy}
            onStatusChange={onStatusChange}
          />
        </div>
      )}

      {config.type === 'opcua-client' && (
        <ServerCertificateCard
          dsName={config.name}
          status={certificateStatus}
          signsIn={signsIn}
          onTrusted={(path) => {
            pinServerCertificate(config.name, path);
            onStatusChange?.();
          }}
        />
      )}

      {/* Settings — only for OPC-UA types */}
      {config.type !== 'static' && (
        <div className="cfg-section">
          <div className="cfg-section__title">Settings</div>

          {config.type === 'opcua-client' && isOpcuaClientSettings(settings) && (
            <OpcuaClientFields
              dsName={config.name}
              settings={settings}
              variables={config.variables}
              onChange={updateSetting}
            />
          )}

          {config.type === 'opcua-test-server' && isTestServerSettings(settings) && (
            <TestServerFields
              settings={settings}
              listeningOn={
                connected && isTestServerSettings(config.settings)
                  ? testServerEndpoint(config.settings)
                  : null
              }
              onChange={updateSetting}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ── Sub-forms ────────────────────────────────────────────────────────────────

/** Every browsed folder that carries a node id, labelled by its path — the
 *  candidates for a browse root, which the operator otherwise has to look up. */
function browseRootOptions(nodes: TreeNode[], prefix = ''): { nodeId: string; path: string }[] {
  return nodes.filter(isFolder).flatMap((folder) => {
    const path = prefix ? `${prefix}/${folder.name}` : folder.name;
    const own = folder.node_id ? [{ nodeId: folder.node_id, path }] : [];
    return [...own, ...browseRootOptions(folder.children, path)];
  });
}

function OpcuaClientFields({
  dsName,
  settings,
  variables,
  onChange,
}: {
  dsName: string;
  settings: OpcuaClientSettings;
  variables: TreeNode[];
  onChange: (key: string, value: unknown) => void;
}) {
  const rootOptions = useMemo(() => browseRootOptions(variables), [variables]);
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
      <CertificateControls
        baseName={dsName}
        path={settings.client_certificate ?? ''}
        disabled={!secureEnabled}
        onGenerated={(paths) => {
          onChange('client_certificate', paths.client_certificate);
          onChange('client_private_key', paths.client_private_key);
          onChange('client_private_key_password', '');
        }}
      />
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
      <PropRow label="Request timeout (s)">
        <input
          className="cfg-prop-input"
          type="number"
          min={1}
          max={300}
          value={settings.request_timeout_s ?? 30}
          onChange={(e) => onChange('request_timeout_s', Number(e.target.value))}
        />
      </PropRow>
      <PropRow
        label="Deadband"
        description="Numbers that change by less than this are not sent. Set 0 when a value's useful changes are this small."
      >
        <input
          className="cfg-prop-input"
          type="number"
          min={0}
          step={0.001}
          value={settings.deadband_abs ?? 0.001}
          onChange={(e) => onChange('deadband_abs', Number(e.target.value))}
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
          value={settings.priority_sampling_interval_ms ?? 50}
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
      <PropRow
        label="Browse Root Node"
        description="The OPC UA node id Browse starts from; empty starts at Objects. Pick a folder from an earlier browse, or hover a folder in the variable table to see its node id."
      >
        <input
          className="cfg-prop-input"
          type="text"
          list={`browse-root-${dsName}`}
          value={settings.browse_root_node ?? ''}
          onChange={(e) => onChange('browse_root_node', e.target.value || undefined)}
          placeholder="e.g. ns=4;s=gPlc (default: Objects)"
        />
        <datalist id={`browse-root-${dsName}`}>
          {rootOptions.map(({ nodeId, path }) => (
            <option key={nodeId} value={nodeId}>
              {path}
            </option>
          ))}
        </datalist>
      </PropRow>
    </>
  );
}

// Secured policy/mode combos the test server can expose, mirroring the
// OPC-UA client's "Security Policy" dropdown so every policy an engineer can
// pick for a real connection can also be exercised locally.
const TEST_SERVER_SECURE_ENDPOINTS = [
  'Basic256Sha256/Sign',
  'Basic256Sha256/SignAndEncrypt',
  'Aes128Sha256RsaOaep/Sign',
  'Aes128Sha256RsaOaep/SignAndEncrypt',
  'Aes256Sha256RsaPss/Sign',
  'Aes256Sha256RsaPss/SignAndEncrypt',
];

const LOOPBACK_HOST = /^(localhost|127(\.\d+){3}|\[::1\])$/i;

/** Where a client reaches a running test server: loopback unless the
 *  datasource is reachable from the network. Then the backend binds every
 *  interface, `0.0.0.0`, which no client can dial — so name the address this
 *  page was opened at instead, the device's own on that network, or a
 *  placeholder when the page came over loopback and says nothing about it. */
function testServerEndpoint(settings: TestServerSettings): string {
  const pageHost = window.location.hostname;
  const host =
    settings.reachable_from_network !== true
      ? '127.0.0.1'
      : LOOPBACK_HOST.test(pageHost)
        ? '<this device’s address>'
        : pageHost;
  return `opc.tcp://${host}:${settings.port ?? 4855}${settings.endpoint_path ?? '/nexthmi/test/'}`;
}

/** A URL that wraps after a path slash rather than inside a word: browsers
 *  offer no break there on their own. */
function wrappableUrl(url: string) {
  return url.split(/(?<=\/)(?!\/)/).map((part, index) => (
    <Fragment key={index}>
      {index > 0 && <wbr />}
      {part}
    </Fragment>
  ));
}

function TestServerFields({
  settings,
  listeningOn,
  onChange,
}: {
  settings: TestServerSettings;
  /** The saved settings' endpoint while the server runs, else null. */
  listeningOn: string | null;
  onChange: (key: string, value: unknown) => void;
}) {
  const securityPolicies = settings.security_policies ?? [];
  const reachable = settings.reachable_from_network === true;

  function toggleEndpoint(entry: string, enabled: boolean) {
    const next = enabled
      ? [...securityPolicies, entry]
      : securityPolicies.filter((e) => e !== entry);
    onChange('security_policies', next);
  }

  return (
    <>
      {listeningOn && (
        <PropRow label="Listening on">
          <ReadOnlyValue mono>{wrappableUrl(listeningOn)}</ReadOnlyValue>
        </PropRow>
      )}
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
      <PropRow
        label="Security Endpoints"
        description="NoSecurity is always available. Enable extra endpoints to test how the connection wizard discovers and negotiates a secured policy."
        block
      >
        <div className="cfg-groups-checkboxes">
          {TEST_SERVER_SECURE_ENDPOINTS.map((entry) => (
            <label key={entry} className="cfg-groups-checkbox">
              <input
                type="checkbox"
                checked={securityPolicies.includes(entry)}
                onChange={(e) => toggleEndpoint(entry, e.target.checked)}
              />
              {entry.replace('/', ' · ')}
            </label>
          ))}
        </div>
      </PropRow>
      <PropRow label="Reachable from the network">
        <BoolButtonGroup
          value={reachable}
          onChange={(v) => onChange('reachable_from_network', v)}
          labels={['On', 'Off']}
        />
      </PropRow>
      {reachable && (
        <p className="cfg-ds-props__warning">
          Every device on the network can connect to this test server and change its writable
          values. Use it only on an isolated network.
        </p>
      )}
      <PropRow label="Sign-in">
        <ReadOnlyValue>Anonymous only. Writes follow each node&rsquo;s access level.</ReadOnlyValue>
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
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The panel is not re-keyed on a datasource switch, so this component
  // survives one — and the timer would otherwise resolve against the newly
  // selected datasource, leaving it stuck on "Starting…".
  useEffect(
    () => () => {
      if (settleTimer.current !== null) clearTimeout(settleTimer.current);
      settleTimer.current = null;
      setActiveAction(null);
    },
    [dsName],
  );

  async function action(endpoint: LifecycleAction) {
    setActiveAction(endpoint);
    try {
      await apiJson(`/api/datasources/${encodeURIComponent(dsName)}/${endpoint}`, {
        method: 'POST',
      });
      settleTimer.current = setTimeout(() => {
        settleTimer.current = null;
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

function ConnectionButtons({
  dsName,
  connected,
  onBusyChange,
  onStatusChange,
}: {
  dsName: string;
  connected: boolean;
  onBusyChange: (value: boolean) => void;
  onStatusChange?: () => void;
}) {
  // Which action is in flight, not the live `connected` prop, decides which
  // button shows — disconnect resolves fast enough that the immediate
  // onStatusChange() below can flip `connected` to false mid-click, which
  // would otherwise swap the branch to "Connect" while still busy.
  const [activeAction, setActiveAction] = useState<'start' | 'stop' | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onBusyChangeRef = useRef(onBusyChange);
  onBusyChangeRef.current = onBusyChange;

  // The panel is not re-keyed on a datasource switch, so this component
  // survives one: clicking Connect on plc1 and selecting plc2 within the delay
  // would otherwise leave plc2 showing "Connecting…" with its error suppressed.
  useEffect(
    () => () => {
      if (settleTimer.current !== null) clearTimeout(settleTimer.current);
      settleTimer.current = null;
      onBusyChangeRef.current(false);
      setActiveAction(null);
    },
    [dsName],
  );

  async function run(action: 'start' | 'stop') {
    setActiveAction(action);
    onBusyChange(true);
    try {
      await apiJson(`/api/datasources/${encodeURIComponent(dsName)}/${action}`, {
        method: 'POST',
      });
      // The endpoint already swapped in a fresh engine (or tore it down) with
      // no stale error — refresh now so it doesn't linger for the full delay.
      onStatusChange?.();
      settleTimer.current = setTimeout(() => {
        settleTimer.current = null;
        onStatusChange?.();
        onBusyChange(false);
        setActiveAction(null);
      }, 2000);
    } catch (e) {
      console.error(`[DatasourcePropertiesPanel] ${action} failed:`, e);
      onBusyChange(false);
      setActiveAction(null);
    }
  }

  const showDisconnect = activeAction ? activeAction === 'stop' : connected;

  return (
    <div className="cfg-ds-props__btn-group">
      {!showDisconnect ? (
        <Button
          variant="success"
          size="sm"
          type="button"
          className="cfg-ds-props__action-btn"
          disabled={activeAction !== null}
          onClick={() => run('start')}
        >
          {activeAction === 'start' ? 'Connecting…' : 'Connect'}
        </Button>
      ) : (
        <Button
          variant="danger"
          size="sm"
          type="button"
          className="cfg-ds-props__action-btn"
          disabled={activeAction !== null}
          onClick={() => run('stop')}
        >
          {activeAction === 'stop' ? 'Disconnecting…' : 'Disconnect'}
        </Button>
      )}
    </div>
  );
}
