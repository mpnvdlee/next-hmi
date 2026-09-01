import './style.css';
import { useState } from 'react';
import Button from '../../ui/Button';
import GenerateCertificateModal from './GenerateCertificateModal';
import CertificateInfoModal from './CertificateInfoModal';

interface GeneratedCertPaths {
  client_certificate: string;
  client_private_key: string;
}

/** Generate / inspect the client certificate a secured OPC-UA connection uses.
 *  Two buttons, each opening its own popup — generating asks for the cert's
 *  parameters instead of guessing them; info is only meaningful once a path is
 *  set, so it stays disabled until one is. Shared by the connection wizard and
 *  the datasource properties panel. */
export default function CertificateControls({
  baseName,
  path,
  onGenerated,
  disabled,
}: {
  baseName: string;
  path: string;
  onGenerated: (paths: GeneratedCertPaths) => void;
  disabled?: boolean;
}) {
  const [modal, setModal] = useState<'generate' | 'info' | null>(null);

  return (
    <div className="cfg-cert-controls">
      <Button
        variant="neutral"
        size="sm"
        disabled={disabled}
        onClick={() => setModal('generate')}
      >
        Generate certificate…
      </Button>
      <Button
        variant="neutral"
        size="sm"
        disabled={disabled || !path}
        onClick={() => setModal('info')}
      >
        Certificate info
      </Button>

      {modal === 'generate' && (
        <GenerateCertificateModal
          baseName={baseName}
          onGenerated={(paths) => {
            onGenerated(paths);
            setModal(null);
          }}
          onCancel={() => setModal(null)}
        />
      )}
      {modal === 'info' && path && (
        <CertificateInfoModal path={path} onClose={() => setModal(null)} />
      )}
    </div>
  );
}
