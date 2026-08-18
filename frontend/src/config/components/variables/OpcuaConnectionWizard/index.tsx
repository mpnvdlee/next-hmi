import './style.css';
import { useMemo, useRef, useState } from 'react';
import type { DiscoveredEndpoint, OpcuaClientSettings } from '@shared/types/datasource';
import { withBase } from '@shared/utils/runtimeBase';
import ModalShell, { ModalCloseButton } from '../../ui/ModalShell';
import Button from '../../ui/Button';
import BoolButtonGroup from '../../ui/BoolButtonGroup';
import EndpointDiscovery from './EndpointDiscovery';
import ConnectionTest from './ConnectionTest';

/** Uploads one client cert / private key / server cert file for the secure
 *  connection step. Called immediately on file selection (not on submit) so
 *  a bad file surfaces right away. Never carries the key password — that
 *  stays a plain settings field, uploaded nowhere. */
async function uploadDatasourceCertificate(file: File): Promise<string> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(withBase('/api/datasources/certs'), { method: 'POST', body: form });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const payload = (await res.json()) as { detail?: unknown };
      if (typeof payload?.detail === 'string' && payload.detail) detail = payload.detail;
    } catch {
      // body wasn't JSON — fall through to the HTTP-code message
    }
    throw new Error(detail);
  }
  const body = (await res.json()) as { path: string };
  return body.path;
}

function CertFileField({
  label,
  value,
  onUploaded,
}: {
  label: string;
  value: string;
  onUploaded: (relativePath: string) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      onUploaded(await uploadDatasourceCertificate(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  return (
    <label className="ds-wizard__field">
      <span className="ds-wizard__field-label">{label}</span>
      <input type="file" onChange={(e) => void handleChange(e)} disabled={uploading} />
      {uploading && <span className="ds-wizard__hint">Uploading…</span>}
      {!uploading && error && <span className="ds-wizard__error">{error}</span>}
      {!uploading && !error && value && <span className="ds-wizard__hint">{value}</span>}
    </label>
  );
}

interface Props {
  existingNames: string[];
  onCreate: (name: string, settings: Partial<OpcuaClientSettings>) => void | Promise<void>;
  onCreateEmpty: (name: string) => void;
  onBrowseVariables: (name: string) => void;
  onClose: () => void;
}

const STEPS = ['Connection', 'Sign-in', 'Sync'] as const;

function hostOf(url: string): string {
  const rest = url.includes('://') ? url.split('://', 2)[1] : url;
  return rest.split('/', 1)[0].split(':', 1)[0];
}

export default function OpcuaConnectionWizard({
  existingNames,
  onCreate,
  onCreateEmpty,
  onBrowseVariables,
  onClose,
}: Props) {
  const [step, setStep] = useState(0);
  const [created, setCreated] = useState(false);
  const [creating, setCreating] = useState(false);

  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);

  const [manualMode, setManualMode] = useState(false);
  const [address, setAddress] = useState('opc.tcp://localhost:4840');
  const [serverUrl, setServerUrl] = useState('');
  const [securityPolicy, setSecurityPolicy] = useState('NoSecurity');
  const [securityMode, setSecurityMode] = useState('');
  const [endpointTokens, setEndpointTokens] = useState<string[] | null>(null);

  const [authMode, setAuthMode] = useState<'anonymous' | 'login'>('anonymous');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const [clientCertificate, setClientCertificate] = useState('');
  const [clientPrivateKey, setClientPrivateKey] = useState('');
  const [clientPrivateKeyPassword, setClientPrivateKeyPassword] = useState('');
  const [serverCertificate, setServerCertificate] = useState('');

  const [backgroundSync, setBackgroundSync] = useState(true);

  const nameInputRef = useRef<HTMLInputElement>(null);

  const trimmedName = name.trim();
  const nameTaken = existingNames.some((n) => n.toLowerCase() === trimmedName.toLowerCase());
  const nameError =
    trimmedName !== '' && nameTaken ? 'A datasource with this name already exists.' : null;
  const nameValid = trimmedName !== '' && !nameTaken;
  const urlSet = serverUrl.trim() !== '';
  const secureEnabled = !!securityPolicy && securityPolicy !== 'NoSecurity';

  function handleEndpointSelect(ep: DiscoveredEndpoint) {
    setServerUrl(ep.endpoint_url);
    setSecurityPolicy(ep.security_policy || 'NoSecurity');
    setSecurityMode(ep.security_mode === 'None' ? '' : ep.security_mode);
    setEndpointTokens(ep.user_tokens);
    if (ep.user_tokens.includes('Anonymous')) setAuthMode('anonymous');
    else if (ep.user_tokens.includes('Username')) setAuthMode('login');
    if (!nameEdited) {
      const suggestion = (ep.server_name || hostOf(ep.endpoint_url)).trim();
      if (suggestion) setName(suggestion);
    }
  }

  const settings = useMemo<Partial<OpcuaClientSettings>>(() => {
    const s: Partial<OpcuaClientSettings> = {
      server_url: serverUrl.trim(),
      username: authMode === 'login' ? username : '',
      password: authMode === 'login' ? password : '',
      disable_background_sync: !backgroundSync,
    };
    if (secureEnabled) {
      s.security_policy = securityPolicy;
      s.security_mode = securityMode || 'SignAndEncrypt';
      if (clientCertificate) s.client_certificate = clientCertificate;
      if (clientPrivateKey) s.client_private_key = clientPrivateKey;
      if (clientPrivateKeyPassword) s.client_private_key_password = clientPrivateKeyPassword;
      if (serverCertificate) s.server_certificate = serverCertificate;
    }
    return s;
  }, [
    serverUrl,
    authMode,
    username,
    password,
    backgroundSync,
    secureEnabled,
    securityPolicy,
    securityMode,
    clientCertificate,
    clientPrivateKey,
    clientPrivateKeyPassword,
    serverCertificate,
  ]);

  const testSettings = useMemo(
    () => ({
      server_url: serverUrl.trim(),
      username: authMode === 'login' ? username : '',
      password: authMode === 'login' ? password : '',
      security_policy: securityPolicy || 'NoSecurity',
      security_mode: securityMode,
    }),
    [serverUrl, authMode, username, password, securityPolicy, securityMode],
  );

  const canNext =
    step === 0
      ? nameValid && urlSet
      : step === 1
        ? authMode === 'anonymous' || username.trim() !== ''
        : true;

  async function handleCreate() {
    if (!nameValid) return;
    setCreating(true);
    try {
      await onCreate(trimmedName, settings);
      setCreated(true);
    } finally {
      setCreating(false);
    }
  }

  function updateName(value: string) {
    setName(value);
    setNameEdited(true);
  }

  // ── Success screen ──────────────────────────────────────────────────────
  if (created) {
    return (
      <ModalShell onClose={onClose} dialogClassName="ds-wizard">
        <header className="cfg-modal-header">
          <h2 className="ds-wizard__title">Connection created</h2>
          <ModalCloseButton onClose={onClose} />
        </header>
        <div className="ds-wizard__body">
          <p className="ds-wizard__success">
            <span className="ds-wizard__success-mark" aria-hidden>
              ✓
            </span>
            <span>
              <strong>{trimmedName}</strong> was created and is connecting. Browse its address space
              now to import variables, or do it later from the variable table.
            </span>
          </p>
        </div>
        <footer className="ds-wizard__footer ds-wizard__footer--end">
          <Button variant="ghost" onClick={onClose}>
            Done
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onBrowseVariables(trimmedName);
              onClose();
            }}
          >
            Browse variables
          </Button>
        </footer>
      </ModalShell>
    );
  }

  // ── Wizard steps ────────────────────────────────────────────────────────
  return (
    <ModalShell onClose={onClose} dialogClassName="ds-wizard" initialFocusRef={nameInputRef}>
      <header className="cfg-modal-header">
        <h2 className="ds-wizard__title">Add OPC-UA connection</h2>
        <ModalCloseButton onClose={onClose} />
      </header>

      <ol className="ds-wizard__steps" aria-label="Wizard steps">
        {STEPS.map((label, i) => (
          <li
            key={label}
            className={`ds-wizard__step${
              i === step ? ' ds-wizard__step--active' : i < step ? ' ds-wizard__step--done' : ''
            }`}
          >
            <span className="ds-wizard__step-dot">{i < step ? '✓' : i + 1}</span>
            <span className="ds-wizard__step-label">{label}</span>
          </li>
        ))}
      </ol>

      <div className="ds-wizard__body">
        {step === 0 && (
          <>
            {manualMode ? (
              <label className="ds-wizard__field">
                <span className="ds-wizard__field-label">Server URL</span>
                <input
                  className="cfg-prop-input"
                  type="text"
                  value={serverUrl}
                  placeholder="opc.tcp://192.168.1.10:4840"
                  onChange={(e) => setServerUrl(e.target.value)}
                />
                <button
                  type="button"
                  className="ds-wizard__link"
                  onClick={() => setManualMode(false)}
                >
                  Discover endpoints instead
                </button>
              </label>
            ) : (
              <div className="ds-wizard__field">
                <span className="ds-wizard__field-label">Discover server</span>
                <EndpointDiscovery
                  address={address}
                  onAddressChange={setAddress}
                  onSelect={handleEndpointSelect}
                />
                <button
                  type="button"
                  className="ds-wizard__link"
                  onClick={() => setManualMode(true)}
                >
                  Enter URL manually instead
                </button>
              </div>
            )}

            <label className="ds-wizard__field">
              <span className="ds-wizard__field-label">Name</span>
              <input
                ref={nameInputRef}
                className="cfg-prop-input"
                type="text"
                value={name}
                placeholder="e.g. LinePLC"
                onChange={(e) => updateName(e.target.value)}
              />
              {nameError && <span className="ds-wizard__error">{nameError}</span>}
            </label>
          </>
        )}

        {step === 1 && (
          <>
            <div className="ds-wizard__field">
              <span className="ds-wizard__field-label">Sign in</span>
              <BoolButtonGroup
                value={authMode === 'anonymous'}
                onChange={(anonymous) => setAuthMode(anonymous ? 'anonymous' : 'login')}
                labels={['Anonymous', 'Username & password']}
              />
              {endpointTokens &&
                !endpointTokens.includes('Anonymous') &&
                authMode === 'anonymous' && (
                  <span className="ds-wizard__error">
                    This endpoint does not advertise anonymous access.
                  </span>
                )}
            </div>

            {authMode === 'login' && (
              <>
                <label className="ds-wizard__field">
                  <span className="ds-wizard__field-label">Username</span>
                  <input
                    className="cfg-prop-input"
                    type="text"
                    value={username}
                    autoComplete="off"
                    onChange={(e) => setUsername(e.target.value)}
                  />
                </label>
                <label className="ds-wizard__field">
                  <span className="ds-wizard__field-label">Password</span>
                  <input
                    className="cfg-prop-input"
                    type="password"
                    value={password}
                    autoComplete="new-password"
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
              </>
            )}

            {secureEnabled && (
              <>
                <CertFileField
                  label="Client Certificate"
                  value={clientCertificate}
                  onUploaded={setClientCertificate}
                />
                <CertFileField
                  label="Client Private Key"
                  value={clientPrivateKey}
                  onUploaded={setClientPrivateKey}
                />
                <label className="ds-wizard__field">
                  <span className="ds-wizard__field-label">Private Key Password</span>
                  <input
                    className="cfg-prop-input"
                    type="password"
                    value={clientPrivateKeyPassword}
                    autoComplete="new-password"
                    placeholder="Optional"
                    onChange={(e) => setClientPrivateKeyPassword(e.target.value)}
                  />
                </label>
                <CertFileField
                  label="Server Certificate"
                  value={serverCertificate}
                  onUploaded={setServerCertificate}
                />
              </>
            )}
          </>
        )}

        {step === 2 && (
          <>
            <div className="ds-wizard__field">
              <div className="ds-wizard__sync-head">
                <span className="ds-wizard__field-label">Background sync</span>
                <BoolButtonGroup value={backgroundSync} onChange={setBackgroundSync} />
              </div>
              <p className="ds-wizard__hint">
                {backgroundSync
                  ? 'Keeps every enabled variable continuously updated in the background — even on pages that aren’t open — so values are ready the moment you navigate. Recommended for most PLCs.'
                  : 'Only reads variables while a page using them is visible. Lighter load on the server and network; values refresh when you open the page.'}
              </p>
            </div>

            <div className="ds-wizard__field">
              <span className="ds-wizard__field-label">Verify</span>
              <ConnectionTest settings={testSettings} />
            </div>
          </>
        )}
      </div>

      <footer className="ds-wizard__footer">
        <div className="ds-wizard__footer-left">
          {step === 0 && (
            <button
              type="button"
              className="ds-wizard__link"
              disabled={!nameValid}
              onClick={() => {
                if (!nameValid) return;
                onCreateEmpty(trimmedName);
                onClose();
              }}
            >
              Create empty instead
            </button>
          )}
        </div>
        <div className="ds-wizard__footer-right">
          {step > 0 && (
            <Button variant="ghost" onClick={() => setStep(step - 1)}>
              ← Back
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {step < 2 ? (
            <Button variant="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>
              Next →
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={!nameValid || creating}
              onClick={() => void handleCreate()}
            >
              {creating ? 'Creating…' : 'Create connection'}
            </Button>
          )}
        </div>
      </footer>
    </ModalShell>
  );
}
