import { useRef, useState } from 'react';
import Button from '../../ui/Button';
import ModalShell from '../../ui/ModalShell';
import { apiJson, errorMessage } from '@shared/utils/api';
import type { GeneratedCertPaths } from '@shared/types/datasource';

const DEFAULT_VALIDITY_DAYS = 3650;

export default function GenerateCertificateModal({
  baseName,
  onGenerated,
  onCancel,
}: {
  baseName: string;
  onGenerated: (paths: GeneratedCertPaths) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(baseName || 'client');
  const [commonName, setCommonName] = useState(baseName || 'webhmi-opc-client');
  const [validityDays, setValidityDays] = useState(DEFAULT_VALIDITY_DAYS);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      const paths = await apiJson<GeneratedCertPaths>('/api/datasources/certs/generate', {
        method: 'POST',
        body: {
          name: name.trim() || 'client',
          common_name: commonName.trim(),
          validity_days: validityDays,
        },
      });
      onGenerated(paths);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setGenerating(false);
    }
  }

  const trimmedName = name.trim() || 'client';

  return (
    <ModalShell
      onClose={onCancel}
      dialogClassName="name-modal cfg-flex-col"
      initialFocusRef={nameRef}
    >
      <div className="name-modal__title">Generate self-signed certificate</div>

      <label className="cert-modal__field">
        <span className="cert-modal__label">File name</span>
        <input
          ref={nameRef}
          className="cfg-prop-input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="client"
        />
        <span className="cert-modal__hint">
          Written as certs/{trimmedName}-cert.der and certs/{trimmedName}-key.pem — generating again
          with this name overwrites the pair in place.
        </span>
      </label>

      <label className="cert-modal__field">
        <span className="cert-modal__label">Common name (CN)</span>
        <input
          className="cfg-prop-input"
          type="text"
          value={commonName}
          onChange={(e) => setCommonName(e.target.value)}
          placeholder="webhmi-opc-client"
        />
      </label>

      <label className="cert-modal__field">
        <span className="cert-modal__label">Validity (days)</span>
        <input
          className="cfg-prop-input"
          type="number"
          min={1}
          max={36500}
          value={validityDays}
          onChange={(e) => setValidityDays(Math.max(1, Number(e.target.value) || 1))}
        />
      </label>

      {error && <p className="cert-modal__error">{error}</p>}

      <div className="name-modal__actions">
        <Button variant="ghost" onClick={onCancel} disabled={generating}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void handleGenerate()} disabled={generating}>
          {generating ? 'Generating…' : 'Generate'}
        </Button>
      </div>
    </ModalShell>
  );
}
