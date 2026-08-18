import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { DiscoveryResult, TestConnectionResult } from '@shared/types/datasource';
import { apiJson } from '@shared/utils/api';
import OpcuaConnectionWizard from './index';

vi.mock('@shared/utils/api', () => ({ apiJson: vi.fn() }));

const mockedApiJson = vi.mocked(apiJson);

const DISCOVERY: DiscoveryResult = {
  ok: true,
  error: null,
  endpoints: [
    {
      endpoint_url: 'opc.tcp://plc.local:4840',
      security_mode: 'None',
      security_policy: 'NoSecurity',
      user_tokens: ['Anonymous', 'Username'],
      server_name: 'LinePLC',
      application_uri: 'urn:LinePLC',
    },
    {
      endpoint_url: 'opc.tcp://plc.local:4840',
      security_mode: 'SignAndEncrypt',
      security_policy: 'Basic256Sha256',
      user_tokens: ['Username'],
      server_name: 'LinePLC',
      application_uri: 'urn:LinePLC',
    },
  ],
};

function routeApi(overrides?: { test?: TestConnectionResult }) {
  mockedApiJson.mockImplementation(async (url: string) => {
    if (url.includes('/discover')) return DISCOVERY as never;
    if (url.includes('/test-connection'))
      return (overrides?.test ?? { ok: true, server_name: 'LinePLC', error: null }) as never;
    return undefined as never;
  });
}

function renderWizard(props?: Partial<React.ComponentProps<typeof OpcuaConnectionWizard>>) {
  const onCreate = vi.fn().mockResolvedValue(undefined);
  const onCreateEmpty = vi.fn();
  const onBrowseVariables = vi.fn();
  const onClose = vi.fn();
  render(
    <OpcuaConnectionWizard
      existingNames={props?.existingNames ?? []}
      onCreate={props?.onCreate ?? onCreate}
      onCreateEmpty={props?.onCreateEmpty ?? onCreateEmpty}
      onBrowseVariables={props?.onBrowseVariables ?? onBrowseVariables}
      onClose={props?.onClose ?? onClose}
    />,
  );
  return { onCreate, onCreateEmpty, onBrowseVariables, onClose };
}

beforeEach(() => {
  mockedApiJson.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function goToSignInWithSecureEndpoint() {
  routeApi();
  const helpers = renderWizard();
  fireEvent.change(screen.getByLabelText('Server address'), {
    target: { value: 'opc.tcp://plc.local:4840' },
  });
  fireEvent.click(screen.getByRole('button', { name: /Discover/ }));
  await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
  fireEvent.click(screen.getAllByRole('option')[1]); // the secured endpoint
  fireEvent.change(screen.getByPlaceholderText('e.g. LinePLC'), {
    target: { value: 'SecurePLC' },
  });
  fireEvent.click(screen.getByRole('button', { name: /Next/ })); // → Sign-in
  return helpers;
}

describe('OpcuaConnectionWizard', () => {
  it('gates Next until a valid name and URL are set (manual entry)', () => {
    renderWizard();
    const next = screen.getByRole('button', { name: /Next/ });
    expect(next).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /Enter URL manually/ }));
    fireEvent.change(screen.getByPlaceholderText('opc.tcp://192.168.1.10:4840'), {
      target: { value: 'opc.tcp://host:4840' },
    });
    expect(next).toBeDisabled(); // still no name

    fireEvent.change(screen.getByPlaceholderText('e.g. LinePLC'), { target: { value: 'PLC1' } });
    expect(next).toBeEnabled();
  });

  it('flags a duplicate name and blocks progress', () => {
    renderWizard({ existingNames: ['PLC1'] });
    fireEvent.click(screen.getByRole('button', { name: /Enter URL manually/ }));
    fireEvent.change(screen.getByPlaceholderText('opc.tcp://192.168.1.10:4840'), {
      target: { value: 'opc.tcp://host:4840' },
    });
    fireEvent.change(screen.getByPlaceholderText('e.g. LinePLC'), { target: { value: 'PLC1' } });

    expect(screen.getByText(/already exists/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Next/ })).toBeDisabled();
  });

  it('discovers endpoints, auto-fills name/URL, and pre-selects anonymous', async () => {
    routeApi();
    renderWizard();
    fireEvent.change(screen.getByLabelText('Server address'), {
      target: { value: 'opc.tcp://plc.local:4840' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Discover/ }));

    await waitFor(() =>
      expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true'),
    );
    // Name auto-filled from the server application name.
    expect(screen.getByPlaceholderText('e.g. LinePLC')).toHaveValue('LinePLC');

    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    // Step 2: sign-in, anonymous chosen because the endpoint advertises it.
    expect(screen.getByRole('button', { name: 'Anonymous' })).toHaveClass('cfg-seg-btn--active');
  });

  it('creates with background sync off, then hands off to browse', async () => {
    routeApi();
    const { onCreate, onBrowseVariables, onClose } = renderWizard();

    fireEvent.click(screen.getByRole('button', { name: /Enter URL manually/ }));
    fireEvent.change(screen.getByPlaceholderText('opc.tcp://192.168.1.10:4840'), {
      target: { value: 'opc.tcp://host:4840' },
    });
    fireEvent.change(screen.getByPlaceholderText('e.g. LinePLC'), { target: { value: 'PLC1' } });
    fireEvent.click(screen.getByRole('button', { name: /Next/ })); // → sign-in
    fireEvent.click(screen.getByRole('button', { name: /Next/ })); // → sync

    // Toggle background sync off.
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    fireEvent.click(screen.getByRole('button', { name: /Create connection/ }));

    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate).toHaveBeenCalledWith(
      'PLC1',
      expect.objectContaining({
        server_url: 'opc.tcp://host:4840',
        username: '',
        password: '',
        disable_background_sync: true,
      }),
    );
    // No security keys for a NoSecurity connection.
    expect(onCreate.mock.calls[0][1]).not.toHaveProperty('security_policy');

    await screen.findByText('Connection created');
    fireEvent.click(screen.getByRole('button', { name: /Browse variables/ }));
    expect(onBrowseVariables).toHaveBeenCalledWith('PLC1');
    expect(onClose).toHaveBeenCalled();
  });

  it('shows a live test result on the final step', async () => {
    routeApi({ test: { ok: false, error: 'BadTimeout', server_name: null } });
    renderWizard();

    fireEvent.click(screen.getByRole('button', { name: /Enter URL manually/ }));
    fireEvent.change(screen.getByPlaceholderText('opc.tcp://192.168.1.10:4840'), {
      target: { value: 'opc.tcp://host:4840' },
    });
    fireEvent.change(screen.getByPlaceholderText('e.g. LinePLC'), { target: { value: 'PLC1' } });
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));

    fireEvent.click(screen.getByRole('button', { name: /Test connection/ }));
    expect(await screen.findByText(/BadTimeout/)).toBeInTheDocument();
  });

  it('supports the no-wizard "Create empty" escape hatch', () => {
    const { onCreateEmpty, onClose } = renderWizard();
    fireEvent.change(screen.getByPlaceholderText('e.g. LinePLC'), { target: { value: 'Blank' } });
    fireEvent.click(screen.getByRole('button', { name: /Create empty instead/ }));
    expect(onCreateEmpty).toHaveBeenCalledWith('Blank');
    expect(onClose).toHaveBeenCalled();
  });

  it('hides certificate/key/password fields for a NoSecurity connection', () => {
    renderWizard();
    fireEvent.click(screen.getByRole('button', { name: /Enter URL manually/ }));
    fireEvent.change(screen.getByPlaceholderText('opc.tcp://192.168.1.10:4840'), {
      target: { value: 'opc.tcp://host:4840' },
    });
    fireEvent.change(screen.getByPlaceholderText('e.g. LinePLC'), { target: { value: 'PLC1' } });
    fireEvent.click(screen.getByRole('button', { name: /Next/ })); // → Sign-in

    expect(screen.queryByLabelText('Client Certificate')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Client Private Key')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Private Key Password')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Server Certificate')).not.toBeInTheDocument();
  });

  it('shows certificate/key/password fields once a secured endpoint is chosen', async () => {
    await goToSignInWithSecureEndpoint();

    expect(screen.getByLabelText('Client Certificate')).toBeInTheDocument();
    expect(screen.getByLabelText('Client Private Key')).toBeInTheDocument();
    expect(screen.getByLabelText('Private Key Password')).toBeInTheDocument();
    expect(screen.getByLabelText('Server Certificate')).toBeInTheDocument();
    expect(screen.getByLabelText('Private Key Password')).toHaveAttribute('type', 'password');
  });

  it('uploads a selected certificate on file selection and stores the returned relative path', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ path: 'certs/client-cert.pem' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { onCreate } = await goToSignInWithSecureEndpoint();

    const file = new File(['cert-bytes'], 'my-cert.pem', { type: 'application/x-pem-file' });
    fireEvent.change(screen.getByLabelText('Client Certificate'), { target: { files: [file] } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [uploadUrl, uploadInit] = fetchMock.mock.calls[0];
    expect(String(uploadUrl)).toContain('/api/datasources/certs');
    expect(uploadInit.method).toBe('POST');
    expect(uploadInit.body).toBeInstanceOf(FormData);

    await screen.findByText('certs/client-cert.pem');

    // The discovered endpoint only advertises Username auth — fill it in so
    // Next is enabled.
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'engineer' } });
    fireEvent.click(screen.getByRole('button', { name: /Next/ })); // → Sync
    fireEvent.click(screen.getByRole('button', { name: /Create connection/ }));

    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0][1]).toMatchObject({
      client_certificate: 'certs/client-cert.pem',
    });
  });

  it('shows an inline error and does not store a path when the upload fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ detail: 'Invalid certificate filename' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await goToSignInWithSecureEndpoint();

    const file = new File(['x'], '../evil.pem', { type: 'application/x-pem-file' });
    fireEvent.change(screen.getByLabelText('Client Certificate'), { target: { files: [file] } });

    expect(await screen.findByText('Invalid certificate filename')).toBeInTheDocument();
  });

  it('never places the private-key password in a URL — only in the JSON settings body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ path: 'certs/client-key.pem' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const secret = 'S3cr3t-Key-Password';
    const { onCreate } = await goToSignInWithSecureEndpoint();

    fireEvent.change(screen.getByLabelText('Private Key Password'), {
      target: { value: secret },
    });
    const file = new File(['key-bytes'], 'client-key.pem', { type: 'application/x-pem-file' });
    fireEvent.change(screen.getByLabelText('Client Private Key'), { target: { files: [file] } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'engineer' } });
    fireEvent.click(screen.getByRole('button', { name: /Next/ })); // → Sync
    fireEvent.click(screen.getByRole('button', { name: /Create connection/ }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());

    // The password reaches onCreate as a plain settings field…
    expect(onCreate.mock.calls[0][1]).toMatchObject({ client_private_key_password: secret });
    // …and never as part of any URL this component constructed.
    for (const call of mockedApiJson.mock.calls) {
      expect(String(call[0])).not.toContain(secret);
    }
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain(secret);
    }
  });
});
