import { useEffect, useRef, useState } from 'react';
import AdminSection from '../AdminSection';
import Button from '@config/components/ui/Button';
import BoolButtonGroup from '@config/components/ui/BoolButtonGroup';
import { ContentSpinner } from '@shared/components/Spinner';
import { describeError } from '@config/store/projectsStore';
import { withBase } from '@shared/utils/runtimeBase';
import './style.css';

export type TlsMode = 'generated' | 'custom';

export interface TlsCertificate {
  fingerprint: string;
  expiresAt: string;
  /** Signed — negative once the certificate has already expired. */
  expiresInDays: number;
  expired: boolean;
  expiring: boolean;
  names: string[];
}

export interface TlsStatus {
  enabled: boolean;
  /** `env` means NEXTHMI_SSL_* owns the setting and this UI stays read-only. */
  source: 'managed' | 'env';
  mode: TlsMode;
  generatedCertificate: TlsCertificate | null;
  customCertificate: TlsCertificate | null;
  /** Set when the stored setting cannot actually be served, e.g. a missing file. */
  error: string | null;
  restartRequired: boolean;
  /**
   * Where the app answers on each protocol. Both are null unless the launcher
   * is the one serving — under `start-dev.py` the listener is rebound on the
   * port it already has, so there is nothing to move to.
   */
  httpPort: number | null;
  httpsPort: number | null;
}

interface Props {
  status: TlsStatus | null;
  onLoad(): Promise<void>;
  onApply(enabled: boolean, mode: TlsMode): Promise<void>;
  onRegenerate(): Promise<void>;
  onUploadCustom(certificate: File, privateKey: File): Promise<void>;
  onRestart(): Promise<void>;
}

const RESTART_POLL_MS = 500;
const RESTART_POLL_ATTEMPTS = 40;

/** The port this page is on, with the scheme's default spelled out. */
function currentPort(): string {
  return window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
}

/**
 * Where this page has to reopen once the protocol changes.
 *
 * Usually the same host and port with the other scheme — the listener is
 * rebound in place. Under the launcher it is not: HTTPS binds a second port and
 * the first one is left redirecting, so a page that stayed put would hit the
 * redirector with a TLS handshake and fail. Only a page actually on the port
 * being vacated follows the move; behind Vite or a terminating proxy the port
 * belongs to something else and must stay as it is.
 */
function targetUrl(https: boolean, tls: TlsStatus | null): string {
  const vacated = (https ? tls?.httpPort : tls?.httpsPort) ?? null;
  const destination = (https ? tls?.httpsPort : tls?.httpPort) ?? null;
  const moves = vacated !== null && destination !== null && currentPort() === String(vacated);
  const port = moves ? String(destination) : window.location.port;
  const host = port ? `${window.location.hostname}:${port}` : window.location.hostname;
  return `${https ? 'https:' : 'http:'}//${host}${window.location.pathname}`;
}

/** Resolve once the current listener stops answering, i.e. the restart began. */
async function waitForListenerToStop(): Promise<void> {
  for (let attempt = 0; attempt < RESTART_POLL_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, RESTART_POLL_MS));
    try {
      await fetch(withBase('/api/system/tls'), { cache: 'no-store' });
    } catch {
      return;
    }
  }
  // Took too long to go down; redirect anyway rather than stranding the page.
}

function formatExpiry(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleDateString();
}

/** Names the fix, not just the problem — the two modes are replaced differently. */
function expiryWarning(certificate: TlsCertificate, mode: TlsMode): string {
  const replace =
    mode === 'custom' ? 'Upload a renewed certificate.' : 'Choose Regenerate to issue a new one.';
  return certificate.expired
    ? `This certificate expired ${Math.abs(certificate.expiresInDays)} days ago. Browsers now refuse it outright. ${replace}`
    : `This certificate expires in ${certificate.expiresInDays} days. ${replace}`;
}

export default function HttpsSection({
  status: tls,
  onLoad,
  onApply,
  onRegenerate,
  onUploadCustom,
  onRestart,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [restartTarget, setRestartTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingMode, setPendingMode] = useState<TlsMode | null>(null);
  const certificateInput = useRef<HTMLInputElement>(null);
  const keyInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void onLoad().catch((reason) => setError(describeError(reason)));
  }, [onLoad]);

  const mode = pendingMode ?? tls?.mode ?? 'generated';

  async function guard(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (reason) {
      setError(describeError(reason));
      throw reason;
    } finally {
      setBusy(false);
    }
  }

  async function applyAndRestart(enabled: boolean) {
    try {
      await guard(async () => {
        await onApply(enabled, mode);
        await onRestart();
      });
    } catch {
      return;
    }
    const destination = targetUrl(enabled, tls);
    setRestartTarget(destination);
    await waitForListenerToStop();
    window.location.replace(destination);
  }

  async function uploadCustom() {
    const certificate = certificateInput.current?.files?.[0];
    const privateKey = keyInput.current?.files?.[0];
    if (!certificate || !privateKey) {
      setError('Choose both a certificate file and a private key file.');
      return;
    }
    await guard(async () => {
      await onUploadCustom(certificate, privateKey);
      setPendingMode(null);
      if (certificateInput.current) certificateInput.current.value = '';
      if (keyInput.current) keyInput.current.value = '';
    }).catch(() => undefined);
  }

  if (!tls) {
    return (
      <AdminSection title="HTTPS">
        <ContentSpinner variant="cfg" />
      </AdminSection>
    );
  }

  if (restartTarget) {
    return (
      <AdminSection title="HTTPS">
        <p className="cfg-admin-section__desc">
          Restarting the manager, then reopening this page on <code>{restartTarget}</code>. Running
          projects come back on their own.
        </p>
        <ContentSpinner variant="cfg" />
      </AdminSection>
    );
  }

  if (tls.source === 'env') {
    return (
      <AdminSection title="HTTPS">
        <p className="cfg-admin-section__desc">
          HTTPS is configured outside this UI through <code>NEXTHMI_SSL_CERTFILE</code> and{' '}
          <code>NEXTHMI_SSL_KEYFILE</code>, so it cannot be changed here.
        </p>
        {tls.error && <p className="cfg-error-banner">{tls.error}</p>}
      </AdminSection>
    );
  }

  const active = mode === 'custom' ? tls.customCertificate : tls.generatedCertificate;
  const modeChanged = tls.mode !== mode;

  return (
    <AdminSection title="HTTPS">
      <p className="cfg-admin-section__desc">
        Sets the protocol for everything this device serves — the manager, and every project&apos;s
        HMI and editor. Leave it on HTTP only while the manager stays on <code>localhost</code>;
        passwords and project data cross the network in the clear otherwise.
      </p>

      <div className="cfg-admin-https__switch" role="group" aria-label="Protocol">
        <button
          type="button"
          className={`cfg-admin-https__choice${!tls.enabled ? ' cfg-admin-https__choice--active' : ''}`}
          aria-pressed={!tls.enabled}
          disabled={busy || !tls.enabled}
          onClick={() => void applyAndRestart(false)}
        >
          HTTP
        </button>
        <button
          type="button"
          className={`cfg-admin-https__choice${tls.enabled ? ' cfg-admin-https__choice--active' : ''}`}
          aria-pressed={tls.enabled}
          disabled={busy}
          onClick={() => void applyAndRestart(true)}
        >
          HTTPS
        </button>
      </div>

      <fieldset className="cfg-admin-https__modes" disabled={busy}>
        <legend className="cfg-admin-https__legend">Certificate</legend>

        <BoolButtonGroup
          value={mode === 'generated'}
          onChange={(generated) => setPendingMode(generated ? 'generated' : 'custom')}
          labels={['Generated for this device', 'My own certificate']}
        />
        <p className="cfg-admin-https__mode-hint">
          {mode === 'generated'
            ? 'Created automatically. No certificate authority signs it, so each browser warns once on first visit until someone accepts it on that machine.'
            : 'PEM certificate (chain first) and an unencrypted PEM private key. Issued by a CA the plant browsers already trust, no warning appears.'}
        </p>
      </fieldset>

      {mode === 'custom' && (
        <div className="cfg-admin-https__upload">
          <label className="cfg-admin-https__file">
            <span className="cfg-admin-https__cert-label">Certificate</span>
            <input type="file" accept=".pem,.crt,.cer" ref={certificateInput} disabled={busy} />
          </label>
          <label className="cfg-admin-https__file">
            <span className="cfg-admin-https__cert-label">Private key</span>
            <input type="file" accept=".pem,.key" ref={keyInput} disabled={busy} />
          </label>
          <Button disabled={busy} onClick={() => void uploadCustom()}>
            {tls.customCertificate ? 'Replace uploaded certificate' : 'Upload certificate'}
          </Button>
          {window.location.protocol !== 'https:' && (
            <p className="cfg-admin-https__hint cfg-admin-https__hint--warn">
              This page is on HTTP, so the private key would be uploaded in the clear. Switch to
              HTTPS with the generated certificate first, then upload your own over that.
            </p>
          )}
        </div>
      )}

      {active ? (
        <div className="cfg-admin-https__cert">
          <div className="cfg-admin-https__cert-row">
            <span className="cfg-admin-https__cert-label">Valid until</span>
            <span
              className={
                active.expired
                  ? 'cfg-admin-https__expiry--expired'
                  : active.expiring
                    ? 'cfg-admin-https__expiry--soon'
                    : undefined
              }
            >
              {formatExpiry(active.expiresAt)}
            </span>
          </div>
          <div className="cfg-admin-https__cert-row">
            <span className="cfg-admin-https__cert-label">Covers</span>
            <span>{active.names.join(', ') || '—'}</span>
          </div>
          <div className="cfg-admin-https__cert-row">
            <span className="cfg-admin-https__cert-label">SHA-256</span>
            <code className="cfg-admin-https__fingerprint">{active.fingerprint}</code>
          </div>
          {active.expiring && (
            <p
              className={`cfg-admin-https__hint ${
                active.expired ? 'cfg-admin-https__hint--expired' : 'cfg-admin-https__hint--warn'
              }`}
            >
              {expiryWarning(active, mode)}
            </p>
          )}
          {mode === 'generated' && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void guard(onRegenerate).catch(() => undefined)}
            >
              Regenerate
            </Button>
          )}
        </div>
      ) : (
        mode === 'custom' && <p className="cfg-admin-https__hint">No certificate uploaded yet.</p>
      )}

      {/* A different certificate only matters while HTTPS is actually serving one. */}
      {(tls.restartRequired || (tls.enabled && modeChanged)) && (
        <p className="cfg-admin-https__hint cfg-admin-https__hint--warn">
          This device is still serving {tls.enabled ? 'HTTPS' : 'HTTP'}
          {tls.enabled && modeChanged ? ' with the previously selected certificate' : ''}. Choose a
          protocol above to restart and apply.
        </p>
      )}

      {error && <p className="cfg-error-banner">{error}</p>}
    </AdminSection>
  );
}
