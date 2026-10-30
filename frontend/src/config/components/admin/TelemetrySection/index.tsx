import { useEffect, useState } from 'react';
import AdminSection from '../AdminSection';
import BoolButtonGroup from '@config/components/ui/BoolButtonGroup';
import { ContentSpinner } from '@shared/components/Spinner';
import { describeError } from '@config/store/projectsStore';
import { contactUrl } from './contactUrl';
import './style.css';

export interface TelemetryStatus {
  enabled: boolean;
  /** Non-null when NEXTHMI_TELEMETRY owns the setting and this UI stays read-only. */
  envOverride: boolean | null;
  installId: string;
  /** True once this installation is past trying it out and the question was never dismissed. */
  contactPrompt: boolean;
}

interface Props {
  status: TelemetryStatus | null;
  onLoad(): Promise<void>;
  onApply(enabled: boolean): Promise<void>;
}

const TITLE = 'Usage reporting';

export default function TelemetrySection({ status, onLoad, onApply }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void onLoad().catch((reason) => setError(describeError(reason)));
  }, [onLoad]);

  if (!status) {
    return (
      <AdminSection title={TITLE}>
        <ContentSpinner variant="cfg" />
      </AdminSection>
    );
  }

  async function apply(enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      await onApply(enabled);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  }

  const pinned = status.envOverride !== null;

  return (
    <AdminSection title={TITLE}>
      <p className="cfg-admin-section__desc cfg-admin-section__desc--wide">
        Reports that this installation is running, once at start-up and once an hour after that, so
        we can count active installations and see where people get stuck. It sends the installation
        ID below, the version and edition, the operating system and Python version, how NEXT HMI was
        installed, how long it has been running, whether it has ever connected to a PLC, saved a
        page or been used over MCP, and rough sizes (0, 1–10, 11–100 or more pages, tags and OPC-UA
        connections) — no names, values or addresses from your projects.{' '}
        <a
          className="cfg-admin-telemetry__link"
          href="https://next-hmi.com/docs/install.html#usage-reporting"
          target="_blank"
          rel="noopener noreferrer"
        >
          Every field it sends
        </a>
        . It is skipped silently whenever this device is offline.
      </p>

      {pinned ? (
        <p className="cfg-admin-section__desc cfg-admin-section__desc--wide">
          Set outside this UI through{' '}
          <code className="cfg-admin-telemetry__code">NEXTHMI_TELEMETRY</code>, which currently has
          it {status.enabled ? 'on' : 'off'}, so it cannot be changed here.
        </p>
      ) : (
        <fieldset className="cfg-admin-telemetry__toggle" disabled={busy}>
          <legend className="cfg-admin-telemetry__legend">Send usage reports</legend>
          <BoolButtonGroup value={status.enabled} onChange={(next) => void apply(next)} />
        </fieldset>
      )}

      <div className="cfg-admin-telemetry__id">
        <span className="cfg-admin-telemetry__id-label">Installation ID</span>
        <code className="cfg-admin-telemetry__id-value">{status.installId}</code>
      </div>

      <p className="cfg-admin-section__desc cfg-admin-section__desc--wide">
        Using NEXT HMI in a machine or product? We would like to hear about it.{' '}
        <a
          className="cfg-admin-telemetry__link"
          href={contactUrl(status)}
          target="_blank"
          rel="noopener noreferrer"
        >
          Tell us about it <span aria-hidden="true">↗</span>
        </a>
      </p>

      {error && <p className="cfg-error-banner">{error}</p>}
    </AdminSection>
  );
}
