import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import HttpsSection, { type TlsCertificate, type TlsStatus } from './index';

afterEach(() => vi.unstubAllGlobals());

/** Put the page on a known origin and capture where it reopens itself. */
function stubLocation(href: string) {
  const url = new URL(href);
  const replace = vi.fn();
  vi.stubGlobal('location', {
    protocol: url.protocol,
    hostname: url.hostname,
    host: url.host,
    port: url.port,
    pathname: url.pathname,
    replace,
  });
  // The restart poll waits for the current listener to stop answering.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
  return replace;
}

function certificate(overrides: Partial<TlsCertificate> = {}): TlsCertificate {
  return {
    fingerprint: 'a'.repeat(64),
    expiresAt: '2046-07-29T00:00:00+00:00',
    expiresInDays: 7300,
    expired: false,
    expiring: false,
    names: ['localhost', '127.0.0.1'],
    ...overrides,
  };
}

function status(overrides: Partial<TlsStatus> = {}): TlsStatus {
  return {
    enabled: false,
    source: 'managed',
    mode: 'generated',
    generatedCertificate: null,
    customCertificate: null,
    error: null,
    restartRequired: false,
    httpPort: null,
    httpsPort: null,
    ...overrides,
  };
}

function renderSection(overrides: Partial<TlsStatus> | null, handlers = {}) {
  const props = {
    status: overrides === null ? null : status(overrides),
    onLoad: vi.fn().mockResolvedValue(undefined),
    onApply: vi.fn().mockResolvedValue(undefined),
    onRegenerate: vi.fn().mockResolvedValue(undefined),
    onUploadCustom: vi.fn().mockResolvedValue(undefined),
    onRestart: vi.fn().mockResolvedValue(undefined),
    ...handlers,
  };
  render(<HttpsSection {...props} />);
  return props;
}

describe('HttpsSection', () => {
  it('marks the protocol the device is actually serving', () => {
    renderSection({ enabled: true });
    expect(screen.getByRole('button', { name: 'HTTPS' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'HTTP' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('applies the chosen protocol with the selected certificate, then restarts', async () => {
    const onApply = vi.fn().mockResolvedValue(undefined);
    const onRestart = vi.fn().mockResolvedValue(undefined);
    renderSection({}, { onApply, onRestart });

    await userEvent.click(screen.getByRole('button', { name: 'HTTPS' }));

    await waitFor(() => expect(onApply).toHaveBeenCalledWith(true, 'generated'));
    expect(onRestart).toHaveBeenCalled();
  });

  it('reopens the page on the port HTTPS actually binds', async () => {
    // The launcher leaves 8000 redirecting and serves the app on 8443, so a
    // page that only swapped its scheme would meet the redirector with a TLS
    // handshake.
    const replace = stubLocation('http://panel:8000/config/admin');
    renderSection({ httpPort: 8000, httpsPort: 8443 });

    await userEvent.click(screen.getByRole('button', { name: 'HTTPS' }));

    expect(screen.getByText('https://panel:8443/config/admin')).toBeInTheDocument();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('https://panel:8443/config/admin'));
  });

  it('reopens the page on the HTTP port when HTTPS is switched off', async () => {
    const replace = stubLocation('https://panel:8443/config/admin');
    renderSection({ enabled: true, httpPort: 8000, httpsPort: 8443 });

    await userEvent.click(screen.getByRole('button', { name: 'HTTP' }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('http://panel:8000/config/admin'));
  });

  it('keeps the port when the listener is rebound in place', async () => {
    // start-dev.py reports neither port: Vite owns :5173 and rebinds it.
    const replace = stubLocation('http://localhost:5173/config/admin');
    renderSection({ httpPort: null, httpsPort: null });

    await userEvent.click(screen.getByRole('button', { name: 'HTTPS' }));

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith('https://localhost:5173/config/admin'),
    );
  });

  it('keeps the port when the page is not on the one being vacated', async () => {
    // A terminating proxy owns :443; the manager's own ports are behind it.
    const replace = stubLocation('https://panel/config/admin');
    renderSection({ enabled: true, httpPort: 8000, httpsPort: 8443 });

    await userEvent.click(screen.getByRole('button', { name: 'HTTP' }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('http://panel/config/admin'));
  });

  it('does not restart when applying the setting failed', async () => {
    const onApply = vi.fn().mockRejectedValue(new Error('nope'));
    const onRestart = vi.fn().mockResolvedValue(undefined);
    renderSection({}, { onApply, onRestart });

    await userEvent.click(screen.getByRole('button', { name: 'HTTPS' }));

    await waitFor(() => expect(screen.getByText('nope')).toBeInTheDocument());
    expect(onRestart).not.toHaveBeenCalled();
  });

  it('uploads the chosen certificate and key', async () => {
    const onUploadCustom = vi.fn().mockResolvedValue(undefined);
    renderSection({ mode: 'custom' }, { onUploadCustom });

    const certificate = new File(['-----BEGIN CERTIFICATE-----'], 'cert.pem');
    const key = new File(['-----BEGIN PRIVATE KEY-----'], 'key.pem');
    await userEvent.upload(screen.getByLabelText('Certificate'), certificate);
    await userEvent.upload(screen.getByLabelText('Private key'), key);
    await userEvent.click(screen.getByRole('button', { name: /Upload certificate/ }));

    await waitFor(() => expect(onUploadCustom).toHaveBeenCalledWith(certificate, key));
  });

  it('refuses to upload with only one of the two files', async () => {
    const onUploadCustom = vi.fn().mockResolvedValue(undefined);
    renderSection({ mode: 'custom' }, { onUploadCustom });

    const certificate = new File(['-----BEGIN CERTIFICATE-----'], 'cert.pem');
    await userEvent.upload(screen.getByLabelText('Certificate'), certificate);
    await userEvent.click(screen.getByRole('button', { name: /Upload certificate/ }));

    expect(onUploadCustom).not.toHaveBeenCalled();
    expect(screen.getByText(/Choose both a certificate file/)).toBeInTheDocument();
  });

  it('warns that a key uploaded over plain HTTP crosses the wire in the clear', () => {
    renderSection({ mode: 'custom' });
    expect(screen.getByText(/private key would be uploaded in the clear/)).toBeInTheDocument();
  });

  it('shows the active certificate and offers regeneration only for the generated one', async () => {
    const onRegenerate = vi.fn().mockResolvedValue(undefined);
    renderSection({ enabled: true, generatedCertificate: certificate() }, { onRegenerate });

    expect(screen.getByText('a'.repeat(64))).toBeInTheDocument();
    expect(screen.getByText('localhost, 127.0.0.1')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    expect(onRegenerate).toHaveBeenCalled();
  });

  it('reports a failed regeneration instead of leaving it unhandled', async () => {
    const onRegenerate = vi.fn().mockRejectedValue(new Error('read-only filesystem'));
    renderSection({ enabled: true, generatedCertificate: certificate() }, { onRegenerate });

    await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }));

    await waitFor(() => expect(screen.getByText('read-only filesystem')).toBeInTheDocument());
  });

  it('hides every control when the environment owns the setting', () => {
    renderSection({ source: 'env', enabled: true });
    expect(screen.queryByRole('button', { name: 'HTTPS' })).not.toBeInTheDocument();
    expect(screen.getByText(/NEXTHMI_SSL_CERTFILE/)).toBeInTheDocument();
  });

  it('surfaces an environment certificate the device cannot actually serve', () => {
    renderSection({
      source: 'env',
      enabled: false,
      error:
        'NEXTHMI_SSL_CERTFILE / NEXTHMI_SSL_KEYFILE point at files that do not exist: /tmp/a.pem.',
    });
    expect(screen.getByText(/files that do not exist/)).toBeInTheDocument();
  });

  it('does not claim a stale certificate is in use while serving plain HTTP', async () => {
    renderSection({ enabled: false, mode: 'generated' });
    await userEvent.click(screen.getByRole('button', { name: /My own certificate/ }));
    expect(screen.queryByText(/still serving/)).not.toBeInTheDocument();
  });

  it('flags the pending certificate change while HTTPS is already serving', async () => {
    renderSection({ enabled: true, mode: 'generated' });
    await userEvent.click(screen.getByRole('button', { name: /My own certificate/ }));
    expect(screen.getByText(/previously selected certificate/)).toBeInTheDocument();
  });

  it('says nothing about expiry while the certificate has years left', () => {
    renderSection({ enabled: true, generatedCertificate: certificate() });
    expect(screen.queryByText(/expires in/)).not.toBeInTheDocument();
  });

  it('warns before expiry and names the fix for a generated certificate', () => {
    renderSection({
      enabled: true,
      generatedCertificate: certificate({ expiresInDays: 30, expiring: true }),
    });
    expect(screen.getByText(/expires in 30 days/)).toBeInTheDocument();
    expect(screen.getByText(/Choose Regenerate/)).toBeInTheDocument();
  });

  it('tells a custom certificate to be re-uploaded rather than regenerated', () => {
    renderSection({
      enabled: true,
      mode: 'custom',
      customCertificate: certificate({ expiresInDays: 14, expiring: true }),
    });
    expect(screen.getByText(/Upload a renewed certificate/)).toBeInTheDocument();
  });

  it('reports an already-expired certificate as past, not as a countdown', () => {
    renderSection({
      enabled: true,
      generatedCertificate: certificate({ expiresInDays: -5, expiring: true, expired: true }),
    });
    expect(screen.getByText(/expired 5 days ago/)).toBeInTheDocument();
    expect(screen.queryByText(/expires in -5/)).not.toBeInTheDocument();
  });

  it('renders a spinner until the status has loaded', () => {
    const props = renderSection(null);
    expect(props.onLoad).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'HTTPS' })).not.toBeInTheDocument();
  });
});
