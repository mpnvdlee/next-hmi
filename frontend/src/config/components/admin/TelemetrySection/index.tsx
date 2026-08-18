import { useEffect, useState } from 'react';
import AdminSection from '../AdminSection';
import BoolButtonGroup from '@config/components/ui/BoolButtonGroup';
import { ContentSpinner } from '@shared/components/Spinner';
import { describeError } from '@config/store/projectsStore';
import './style.css';

export interface TelemetryStatus {
  enabled: boolean;
  /** Non-null when NEXTHMI_TELEMETRY owns the setting and this UI stays read-only. */
  envOverride: boolean | null;
  installId: string;
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
      <p className="cfg-admin-section__desc">
        Reports that this installation started, once at start-up and once a day after that, so we
        can count active installations. It sends the installation ID below, the version and edition,
        the operating system and the Python version — nothing about your projects, variables or
        network. It is skipped silently whenever this device is offline.
      </p>

      {pinned ? (
        <p className="cfg-admin-section__desc">
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

      {error && <p className="cfg-error-banner">{error}</p>}
    </AdminSection>
  );
}
