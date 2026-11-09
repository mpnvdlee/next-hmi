import './style.css';
import { useEffect, useState } from 'react';
import Button from '../../ui/Button';
import { apiJson, errorMessage } from '@shared/utils/api';
import { formatFingerprint } from '@shared/utils/formatFingerprint';
import type { ServerCertificateInfo, ServerCertificateStatus } from '@shared/types/datasource';

/** Explicit trust for a secured connection's server certificate. Shown
 *  while the endpoint presents one that is not pinned; trusting pins exactly
 *  the fingerprint on screen, and the backend restarts the connection on it.
 *  The one place the panel says why such a connection holds: "Not now" folds
 *  it to a single line rather than hiding it, so that reason stays in view. */
export default function ServerCertificateCard({
  dsName,
  status,
  signsIn,
  onTrusted,
}: {
  dsName: string;
  status: ServerCertificateStatus | null;
  /** The datasource sends a username — the connection waits for trust. */
  signsIn: boolean;
  onTrusted: (serverCertificate: string) => void;
}) {
  const [info, setInfo] = useState<ServerCertificateInfo | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [trusting, setTrusting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = status === 'untrusted' || status === 'changed';
  const url = `/api/datasources/${encodeURIComponent(dsName)}/server-certificate`;

  useEffect(() => {
    setInfo(null);
    setCollapsed(false);
    setError(null);
    if (!pending) return;
    let cancelled = false;
    apiJson<ServerCertificateInfo | null>(url)
      .then((result) => {
        if (!cancelled) setInfo(result);
      })
      .catch((err) => console.error('[ServerCertificateCard] load failed:', err));
    return () => {
      cancelled = true;
    };
  }, [url, pending, status]);

  if (!pending || !info || info.status === 'trusted') return null;
  const changed = info.status === 'changed';

  async function trust(fingerprint: string) {
    setTrusting(true);
    setError(null);
    try {
      const result = await apiJson<{ server_certificate: string }>(`${url}/trust`, {
        method: 'POST',
        body: { fingerprint },
      });
      setInfo(null);
      onTrusted(result.server_certificate);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setTrusting(false);
    }
  }

  if (collapsed) {
    return (
      <div className="cfg-section cfg-server-cert">
        <div className="cfg-section__title">Server certificate</div>
        <div className="cfg-server-cert__summary">
          <span className={`cfg-server-cert__state--${changed ? 'changed' : 'untrusted'}`}>
            {changed
              ? 'Changed since you trusted it. The connection stays stopped.'
              : signsIn
                ? 'Not trusted yet. The connection waits for it.'
                : 'Not trusted yet.'}
          </span>
          <Button variant="neutral" size="sm" onClick={() => setCollapsed(false)}>
            Review certificate
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="cfg-section cfg-server-cert">
      <div className="cfg-section__title">Server certificate</div>
      {changed && (
        <div className="cfg-error-banner" role="alert">
          The server certificate changed since you trusted it. The connection stays stopped until
          you trust the new one. Check with the PLC first: an unexpected change can mean someone is
          intercepting the connection.
        </div>
      )}
      <dl className="cfg-server-cert__list">
        <dt>Subject</dt>
        <dd>{info.subject}</dd>
        <dt>Issuer</dt>
        <dd>{info.issuer}</dd>
        <dt>Valid until</dt>
        <dd>{new Date(info.expiresAt).toLocaleString()}</dd>
        <dt>SHA-256</dt>
        <dd className="cfg-server-cert__fingerprint">{formatFingerprint(info.fingerprint)}</dd>
      </dl>
      <p className="cfg-section__note">
        {!changed &&
          (signsIn
            ? 'The connection waits for you: the username and password are sent only after you trust this certificate. '
            : 'Until you trust it, this connection cannot tell the PLC from an impostor. ')}
        Compare the fingerprint with the server certificate in the PLC&rsquo;s OPC UA settings.
      </p>
      {error && <p className="cert-modal__error">{error}</p>}
      <div className="cfg-ds-props__btn-group">
        <Button
          variant="primary"
          size="sm"
          disabled={trusting}
          onClick={() => void trust(info.fingerprint)}
        >
          {trusting ? 'Trusting…' : 'Trust certificate'}
        </Button>
        <Button variant="ghost" size="sm" disabled={trusting} onClick={() => setCollapsed(true)}>
          Not now
        </Button>
      </div>
    </div>
  );
}
