/**
 * AdsSettingsForm — the connection settings of an `ads-client` datasource,
 * shared by the create dialog and the properties panel.
 *
 * Up front what every connection needs (PLC address, AMS NetID and port, a
 * Test connection), then how the PLC's AMS route for this HMI comes to exist,
 * then what the PLC browse shows, then everything else under a collapsed
 * "Advanced" section. Setting keys and
 * defaults: docs/dev/architecture/data-formats.md (Datasource Files).
 */

import './style.css';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type {
  AdsAddRouteResult,
  AdsClientSettings,
  AdsTestConnectionResult,
} from '@shared/types/datasource';
import { apiJson } from '@shared/utils/api';
import Button from '@config/components/ui/Button';
import BoolButtonGroup from '@config/components/ui/BoolButtonGroup';
import CollapsibleSection from '@config/components/ui/CollapsibleSection';
import PropRow from '@config/components/ui/PropRow';
import Select from '@config/components/ui/Select';

/** What a connected datasource presents to the PLC (the datasource list's
 *  `local_net_id` / `local_ip`). */
export interface AdsLocalIdentity {
  netId: string;
  ip: string | null;
}

interface Props {
  settings: AdsClientSettings;
  onChange: (key: string, value: unknown) => void;
  /** The datasource's live connection is up: a test would be refused. */
  connected?: boolean;
  /** Set while the datasource is connected: the route steps show its values. */
  connectedIdentity?: AdsLocalIdentity | null;
}

type Outcome = { ok: boolean; message: string };

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** TwinCAT's own default NetID for an IPv4 address: the address plus `.1.1`. */
function defaultNetId(host: string): string | null {
  return IPV4.test(host.trim()) ? `${host.trim()}.1.1` : null;
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function OutcomeLine({ outcome }: { outcome: Outcome | null }) {
  if (!outcome) return null;
  return (
    <span
      className={`ds-ads__outcome ds-ads__outcome--${outcome.ok ? 'ok' : 'fail'}`}
      role="status"
    >
      {outcome.ok ? '✓ ' : '✕ '}
      {outcome.message}
    </span>
  );
}

function NumberRow({
  label,
  value,
  fallback,
  min,
  max,
  step,
  disabled,
  description,
  onChange,
}: {
  label: string;
  value: number | undefined;
  fallback: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  description?: ReactNode;
  onChange: (value: number | undefined) => void;
}) {
  return (
    <PropRow label={label} description={description}>
      <input
        className="cfg-prop-input"
        type="number"
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        value={value ?? ''}
        placeholder={String(fallback)}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      />
    </PropRow>
  );
}

/** Where to add the route in TwinCAT, with the values this HMI needs. */
function TwincatRouteSteps({ netId, ip }: { netId: string | null; ip: string | null }) {
  const placeholder = <em>this HMI’s IP address</em>;
  return (
    <div className="ds-ads__route-steps">
      <p className="ds-ads__hint">
        The PLC answers ADS only from a client it has a static route for. Add one in TwinCAT on the
        PLC:
      </p>
      <ol className="ds-ads__steps">
        <li>
          On the PLC, right-click the TwinCAT icon in the taskbar and open{' '}
          <strong>Router → Edit Routes</strong>, then <strong>Add…</strong> (or use TwinCAT XAE’s
          route dialog for that target).
        </li>
        <li>
          Add a route manually, of type <strong>Static</strong>, with these values:
          <dl className="ds-ads__values">
            <dt>AMS NetID</dt>
            <dd>{netId ? <code>{netId}</code> : <>{placeholder} followed by .1.1</>}</dd>
            <dt>Address (IP)</dt>
            <dd>{ip ? <code>{ip}</code> : placeholder}</dd>
            <dt>Transport</dt>
            <dd>TCP/IP</dd>
            <dt>Route name</dt>
            <dd>any, e.g. NEXT-HMI</dd>
          </dl>
        </li>
        <li>Confirm, then run Test connection again.</li>
      </ol>
      {!(netId && ip) && (
        <p className="ds-ads__hint">
          Run Test connection to fill in the exact NetID and address this HMI uses.
        </p>
      )}
    </div>
  );
}

export default function AdsSettingsForm({
  settings,
  onChange,
  connected = false,
  connectedIdentity,
}: Props) {
  const host = settings.host ?? '';
  const localRouter = settings.local_router ?? false;
  const routeMethod = settings.route_method ?? 'twincat';
  const browseMode = settings.browse_mode ?? 'marked';
  const netIdHint = defaultNetId(host);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AdsTestConnectionResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [addingRoute, setAddingRoute] = useState(false);
  const [routeOutcome, setRouteOutcome] = useState<Outcome | null>(null);

  // Only what the probe reads — not the route password.
  const testBody = useMemo(
    () => ({
      host: host.trim(),
      ams_net_id: settings.ams_net_id ?? '',
      ams_port: settings.ams_port,
      tcp_port: settings.tcp_port,
      local_ams_net_id: settings.local_ams_net_id ?? '',
      local_router: localRouter,
      connect_timeout_s: settings.connect_timeout_s,
      request_timeout_s: settings.request_timeout_s,
    }),
    [
      host,
      settings.ams_net_id,
      settings.ams_port,
      settings.tcp_port,
      settings.local_ams_net_id,
      localRouter,
      settings.connect_timeout_s,
      settings.request_timeout_s,
    ],
  );

  // A result for other inputs would mislead — reset when they change.
  useEffect(() => {
    setTestResult(null);
    setTestError(null);
  }, [testBody]);

  async function runTest() {
    setTesting(true);
    setTestResult(null);
    setTestError(null);
    try {
      setTestResult(
        await apiJson<AdsTestConnectionResult>('/api/datasources/ads/test-connection', {
          method: 'POST',
          body: testBody,
        }),
      );
    } catch (err) {
      setTestError(errorText(err, 'Connection test failed'));
    } finally {
      setTesting(false);
    }
  }

  async function createRoute() {
    setAddingRoute(true);
    setRouteOutcome(null);
    try {
      const res = await apiJson<AdsAddRouteResult>('/api/datasources/ads/add-route', {
        method: 'POST',
        body: {
          host: host.trim(),
          ams_net_id: settings.ams_net_id ?? '',
          local_ams_net_id: settings.local_ams_net_id ?? '',
          route_name: settings.route_name ?? '',
          route_address: settings.route_address ?? '',
          request_timeout_s: settings.request_timeout_s,
          user: settings.route_user ?? '',
          password: settings.route_password ?? '',
        },
      });
      setRouteOutcome(
        res.ok
          ? {
              ok: true,
              message: `Route “${res.route_name}” created on the PLC for ${res.net_id} at ${res.address}`,
            }
          : { ok: false, message: res.error ?? 'The PLC did not create the route' },
      );
    } catch (err) {
      setRouteOutcome({ ok: false, message: errorText(err, 'Creating the route failed') });
    } finally {
      setAddingRoute(false);
    }
  }

  const testOutcome: Outcome | null = testError
    ? { ok: false, message: testError }
    : testResult
      ? testResult.ok
        ? {
            ok: true,
            message: [
              testResult.device_name || 'Connected',
              testResult.version && `v${testResult.version}`,
              testResult.ads_state && `ADS state ${testResult.ads_state}`,
            ]
              .filter(Boolean)
              .join(' · '),
          }
        : { ok: false, message: testResult.error ?? 'Connection failed' }
      : null;

  // What the route on the PLC must name: a test's values, else the running
  // connection's, else what the settings fix; null until one is known.
  const routeNetId =
    testResult?.local_net_id ||
    connectedIdentity?.netId ||
    settings.local_ams_net_id?.trim() ||
    null;
  const routeIp =
    testResult?.local_ip || connectedIdentity?.ip || settings.route_address?.trim() || null;

  function setRouteMethod(method: string) {
    onChange('route_method', method);
    // The PLC account is only for a custom route: not kept with any other.
    if (method !== 'custom') {
      onChange('route_user', undefined);
      onChange('route_password', undefined);
    }
  }

  return (
    <>
      <div className="cfg-section">
        <div className="cfg-section__title">Connection</div>
        <PropRow label="PLC IP / Host">
          <input
            className="cfg-prop-input"
            type="text"
            value={host}
            placeholder="192.168.1.10"
            onChange={(e) => onChange('host', e.target.value)}
          />
        </PropRow>
        <PropRow
          label="PLC AMS NetID"
          description="Usually the PLC's IP address followed by .1.1 — leave empty to use that."
        >
          <input
            className="cfg-prop-input"
            type="text"
            value={settings.ams_net_id ?? ''}
            placeholder={netIdHint ?? '<IP>.1.1'}
            onChange={(e) => onChange('ams_net_id', e.target.value)}
          />
        </PropRow>
        <NumberRow
          label="AMS Port"
          description="851 is the first TwinCAT 3 PLC runtime; TwinCAT 2 uses 801."
          value={settings.ams_port}
          fallback={851}
          min={1}
          max={65535}
          onChange={(v) => onChange('ams_port', v)}
        />
        {connected ? (
          // The PLC closes a second connection from the same NetID, so a test
          // now would fail while the live connection works.
          <p className="ds-ads__hint">
            Connected to the PLC. It takes one connection from this HMI at a time: Disconnect to
            test changed settings.
          </p>
        ) : (
          <div className="ds-ads__action">
            <Button
              variant="neutral"
              size="sm"
              onClick={() => void runTest()}
              disabled={testing || !host.trim()}
            >
              {testing ? 'Testing…' : 'Test connection'}
            </Button>
            <OutcomeLine outcome={testOutcome} />
          </div>
        )}
      </div>

      <div className="cfg-section">
        <div className="cfg-section__title">Route</div>
        {localRouter ? (
          <p className="ds-ads__hint">
            Connecting through the local TwinCAT router: the routes belong to that router. Add or
            check its route to the PLC with TwinCAT on this machine.
          </p>
        ) : (
          <>
            <PropRow label="Route Method">
              <Select value={routeMethod} onChange={setRouteMethod}>
                <option value="twincat">TwinCAT route</option>
                <option value="custom">Custom route</option>
              </Select>
            </PropRow>
            {routeMethod === 'twincat' ? (
              <TwincatRouteSteps netId={routeNetId} ip={routeIp} />
            ) : (
              <>
                <p className="ds-ads__hint">
                  NEXT HMI asks the PLC to add the route — the same request TwinCAT’s Add Route
                  dialog sends — using a user account on the PLC. It also does this by itself
                  whenever it connects and finds the route missing.
                </p>
                <PropRow label="PLC User">
                  <input
                    className="cfg-prop-input"
                    type="text"
                    value={settings.route_user ?? ''}
                    autoComplete="off"
                    placeholder="Administrator"
                    onChange={(e) => onChange('route_user', e.target.value)}
                  />
                </PropRow>
                <PropRow label="PLC Password">
                  <input
                    className="cfg-prop-input"
                    type="password"
                    value={settings.route_password ?? ''}
                    autoComplete="new-password"
                    onChange={(e) => onChange('route_password', e.target.value)}
                  />
                </PropRow>
                <PropRow label="Route Name">
                  <input
                    className="cfg-prop-input"
                    type="text"
                    value={settings.route_name ?? ''}
                    placeholder="<hostname>-nexthmi"
                    onChange={(e) => onChange('route_name', e.target.value)}
                  />
                </PropRow>
                <PropRow
                  label="Route Address"
                  description="Only behind NAT: the address the PLC sees this HMI as."
                >
                  <input
                    className="cfg-prop-input"
                    type="text"
                    value={settings.route_address ?? ''}
                    placeholder="this HMI's IP toward the PLC"
                    onChange={(e) => onChange('route_address', e.target.value)}
                  />
                </PropRow>
                <div className="ds-ads__action">
                  <Button
                    variant="neutral"
                    size="sm"
                    onClick={() => void createRoute()}
                    disabled={addingRoute || !host.trim() || !settings.route_user?.trim()}
                  >
                    {addingRoute ? 'Creating route…' : 'Create route now'}
                  </Button>
                  <OutcomeLine outcome={routeOutcome} />
                </div>
              </>
            )}
          </>
        )}
      </div>

      <div className="cfg-section">
        <div className="cfg-section__title">Browse</div>
        <PropRow label="Browse Root">
          <input
            className="cfg-prop-input"
            type="text"
            value={settings.browse_root ?? ''}
            placeholder="e.g. GVL_HMI (default: whole program)"
            onChange={(e) => onChange('browse_root', e.target.value)}
          />
        </PropRow>
        <PropRow
          label="Browse Mode"
          description={
            browseMode === 'marked'
              ? 'Only variables marked with one of the attributes below.'
              : browseMode === 'lazy'
                ? 'One level at a time: expand a folder or struct to load what is inside.'
                : 'The whole program at once — can be very large on a real machine.'
          }
        >
          <Select value={browseMode} onChange={(v) => onChange('browse_mode', v)}>
            <option value="marked">Marked by attribute</option>
            <option value="lazy">Lazy (one level)</option>
            <option value="all">All</option>
          </Select>
        </PropRow>
        <PropRow
          label="Browse Attributes"
          description="Comma-separated; e.g. OPC.UA.DA marks {attribute 'OPC.UA.DA' := '1'}."
        >
          <input
            className="cfg-prop-input"
            type="text"
            value={settings.browse_attributes ?? ''}
            disabled={browseMode !== 'marked'}
            placeholder="OPC.UA.DA"
            onChange={(e) => onChange('browse_attributes', e.target.value)}
          />
        </PropRow>
      </div>

      <CollapsibleSection title="Advanced" defaultCollapsed>
        <PropRow
          label="This HMI's AMS NetID"
          description="The NetID the PLC's route names. Empty: this machine's IP address plus .1.1."
        >
          <input
            className="cfg-prop-input"
            type="text"
            value={settings.local_ams_net_id ?? ''}
            disabled={localRouter}
            placeholder={testResult?.local_ip ? `${testResult.local_ip}.1.1` : '<local IP>.1.1'}
            onChange={(e) => onChange('local_ams_net_id', e.target.value)}
          />
        </PropRow>
        <PropRow
          label="Local TwinCAT Router"
          description="Connect through a TwinCAT router on this PC (127.0.0.1), which assigns the NetID and owns the routes."
        >
          <BoolButtonGroup
            value={localRouter}
            onChange={(v) => onChange('local_router', v)}
            labels={['On', 'Off']}
          />
        </PropRow>
        <NumberRow
          label="TCP Port"
          value={settings.tcp_port}
          fallback={48898}
          min={1}
          max={65535}
          onChange={(v) => onChange('tcp_port', v)}
        />
        <NumberRow
          label="Connect Timeout (s)"
          value={settings.connect_timeout_s}
          fallback={10}
          min={1}
          max={120}
          onChange={(v) => onChange('connect_timeout_s', v)}
        />
        <NumberRow
          label="Request Timeout (s)"
          value={settings.request_timeout_s}
          fallback={5}
          min={0.5}
          max={60}
          step={0.5}
          onChange={(v) => onChange('request_timeout_s', v)}
        />
        <NumberRow
          label="Reconnect (s)"
          value={settings.reconnect_interval_s}
          fallback={5}
          min={1}
          max={300}
          onChange={(v) => onChange('reconnect_interval_s', v)}
        />
        <NumberRow
          label="Poll Interval (ms)"
          description="How often every enabled variable is read in the background."
          value={settings.bg_publish_interval_ms}
          fallback={1000}
          min={50}
          max={60000}
          step={50}
          disabled={settings.disable_background_sync ?? false}
          onChange={(v) => onChange('bg_publish_interval_ms', v)}
        />
        <NumberRow
          label="Fast Max Delay (ms)"
          description="On-screen variables: how long the PLC may hold back a change."
          value={settings.priority_publish_interval_ms}
          fallback={50}
          min={0}
          max={5000}
          step={5}
          onChange={(v) => onChange('priority_publish_interval_ms', v)}
        />
        <NumberRow
          label="Fast Sampling (ms)"
          value={settings.priority_sampling_interval_ms}
          fallback={20}
          min={1}
          max={5000}
          step={5}
          onChange={(v) => onChange('priority_sampling_interval_ms', v)}
        />
        <NumberRow
          label="Fast WS Batch (ms)"
          value={settings.priority_ws_batch_ms}
          fallback={10}
          min={0}
          max={1000}
          step={5}
          onChange={(v) => onChange('priority_ws_batch_ms', v)}
        />
        <PropRow
          label="Background Sync"
          description="Polls every enabled variable, so values are warm before a page asks for them."
        >
          <BoolButtonGroup
            value={!(settings.disable_background_sync ?? false)}
            onChange={(v) => onChange('disable_background_sync', !v)}
            labels={['On', 'Off']}
          />
        </PropRow>
      </CollapsibleSection>
    </>
  );
}
