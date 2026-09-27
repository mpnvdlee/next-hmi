import { useEffect, useState } from 'react';
import Button from '../../ui/Button';
import ModalShell from '../../ui/ModalShell';
import { apiJson, errorMessage } from '@shared/utils/api';
import type { CertificateInfo } from '@shared/types/datasource';

function formatDate(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
}

function statusClass(info: CertificateInfo): string {
  if (info.expired) return 'cert-modal__status--expired';
  if (info.expiring) return 'cert-modal__status--expiring';
  return 'cert-modal__status--valid';
}

function statusText(info: CertificateInfo): string {
  if (info.expired) return `Expired ${Math.abs(info.expiresInDays)} days ago`;
  if (info.expiring) return `Expires in ${info.expiresInDays} days`;
  return `Valid — ${info.expiresInDays} days left`;
}

export default function CertificateInfoModal({
  path,
  onClose,
}: {
  path: string;
  onClose: () => void;
}) {
  const [info, setInfo] = useState<CertificateInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiJson<CertificateInfo>(`/api/datasources/certs/info?path=${encodeURIComponent(path)}`)
      .then((result) => {
        if (!cancelled) setInfo(result);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <ModalShell onClose={onClose} dialogClassName="name-modal cfg-flex-col cert-info-modal">
      <div className="name-modal__title">Certificate info</div>
      <p className="cert-modal__hint cert-info-modal__path">{path}</p>

      {loading && <p className="cert-modal__hint">Reading certificate…</p>}
      {!loading && error && <p className="cert-modal__error">{error}</p>}
      {!loading && !error && info && !info.readable && (
        <p className="cert-modal__error">No certificate could be read at this path.</p>
      )}
      {!loading && !error && info?.readable && (
        <dl className="cert-info-modal__list">
          <dt>Subject</dt>
          <dd>{info.subject}</dd>
          <dt>Status</dt>
          <dd className={statusClass(info)}>{statusText(info)}</dd>
          <dt>Issued</dt>
          <dd>{formatDate(info.issuedAt)}</dd>
          <dt>Expires</dt>
          <dd>{formatDate(info.expiresAt)}</dd>
          <dt>Self-signed</dt>
          <dd>{info.selfSigned ? 'Yes' : 'No'}</dd>
          <dt>Subject alt names</dt>
          <dd>{info.names.length > 0 ? info.names.join(', ') : '—'}</dd>
          <dt>Fingerprint (SHA-256)</dt>
          <dd className="cert-info-modal__fingerprint">{info.fingerprint}</dd>
        </dl>
      )}

      <div className="name-modal__actions">
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </ModalShell>
  );
}
