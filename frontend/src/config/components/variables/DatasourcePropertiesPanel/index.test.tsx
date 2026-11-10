import { render, screen, fireEvent, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVariablesDomainStore } from '@config/store/domains/variablesDomainStore';
import type { DatasourceConfig } from '@shared/types/datasource';
import { apiJson } from '@shared/utils/api';
import DatasourcePropertiesPanel from './index';

vi.mock('@shared/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/utils/api')>()),
  apiJson: vi.fn(),
}));

const mockedApiJson = vi.mocked(apiJson);

function makeTestServerConfig(): DatasourceConfig {
  return {
    type: 'opcua-test-server',
    name: 'TestServer',
    settings: { port: 4855, endpoint_path: '/nexthmi/test/' },
    variables: [],
  };
}

function makeOpcuaClientConfig(): DatasourceConfig {
  return {
    type: 'opcua-client',
    name: 'PLC',
    settings: {
      server_url: 'opc.tcp://plc:4840',
      username: '',
      password: '',
      security_policy: 'NoSecurity',
      security_mode: 'SignAndEncrypt',
      client_certificate: '',
      client_private_key: '',
      client_private_key_password: '',
      server_certificate: '',
      reconnect_interval_s: 5,
    },
    variables: [],
  };
}

describe('DatasourcePropertiesPanel', () => {
  beforeEach(() => {
    mockedApiJson.mockReset();
    useVariablesDomainStore.setState({ propsDrafts: {} });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('suggests browsed folders, by path, as the browse root node', () => {
    const config = makeOpcuaClientConfig();
    config.variables = [
      {
        kind: 'folder',
        name: 'PLC',
        node_id: 'ns=4;s=gPlc',
        children: [
          { kind: 'folder', name: 'Line1', node_id: 'ns=4;s=gPlc.Line1', children: [] },
          {
            kind: 'variable',
            node_id: 'ns=4;s=gPlc.Speed',
            display_name: 'Speed',
            data_type: 'Float',
            enabled: true,
          },
        ],
      },
    ];

    const { container } = render(
      <DatasourcePropertiesPanel config={config} connected={false} onSave={vi.fn()} />,
    );

    const options = [...container.querySelectorAll('datalist#browse-root-PLC option')];
    expect(options.map((o) => [o.getAttribute('value'), o.textContent])).toEqual([
      ['ns=4;s=gPlc', 'PLC'],
      ['ns=4;s=gPlc.Line1', 'PLC/Line1'],
    ]);
  });

  describe('LifecycleButtons', () => {
    it('shows Starting… while in flight, then reverts and refreshes status after the 1500ms delay', async () => {
      mockedApiJson.mockResolvedValue(undefined);
      const onStatusChange = vi.fn();

      render(
        <DatasourcePropertiesPanel
          config={makeTestServerConfig()}
          connected={false}
          onSave={vi.fn()}
          onStatusChange={onStatusChange}
        />,
      );

      const startButton = screen.getByRole('button', { name: 'Start' });
      fireEvent.click(startButton);
      await act(() => vi.advanceTimersByTimeAsync(0));

      expect(mockedApiJson).toHaveBeenCalledWith(
        '/api/datasources/TestServer/start',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled();
      expect(onStatusChange).not.toHaveBeenCalled();

      await act(() => vi.advanceTimersByTimeAsync(1499));
      expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled();
      expect(onStatusChange).not.toHaveBeenCalled();

      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(onStatusChange).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled();
    });

    it('clears its settle timeout on unmount', async () => {
      mockedApiJson.mockResolvedValue(undefined);
      const onStatusChange = vi.fn();

      const { unmount } = render(
        <DatasourcePropertiesPanel
          config={makeTestServerConfig()}
          connected={false}
          onSave={vi.fn()}
          onStatusChange={onStatusChange}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Start' }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(onStatusChange).not.toHaveBeenCalled();

      unmount();

      await act(() => vi.advanceTimersByTimeAsync(1500));

      expect(onStatusChange).not.toHaveBeenCalled();
    });
  });

  describe('ConnectionButtons', () => {
    it('shows only Connect while disconnected, and calls /start on click', async () => {
      mockedApiJson.mockResolvedValue(undefined);
      const onStatusChange = vi.fn();

      render(
        <DatasourcePropertiesPanel
          config={makeOpcuaClientConfig()}
          connected={false}
          onSave={vi.fn()}
          onStatusChange={onStatusChange}
        />,
      );

      expect(screen.queryByRole('button', { name: /^Disconnect/ })).toBeNull();
      const connectButton = screen.getByRole('button', { name: 'Connect' });
      fireEvent.click(connectButton);
      await act(() => vi.advanceTimersByTimeAsync(0));

      expect(mockedApiJson).toHaveBeenCalledWith(
        '/api/datasources/PLC/start',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(screen.getByRole('button', { name: 'Connecting…' })).toBeDisabled();
      expect(onStatusChange).toHaveBeenCalledTimes(1);

      await act(() => vi.advanceTimersByTimeAsync(1999));
      expect(screen.getByRole('button', { name: 'Connecting…' })).toBeDisabled();
      expect(onStatusChange).toHaveBeenCalledTimes(1);

      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(onStatusChange).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();
    });

    it('shows only Disconnect while connected, and calls /stop on click', async () => {
      mockedApiJson.mockResolvedValue(undefined);
      const onStatusChange = vi.fn();

      render(
        <DatasourcePropertiesPanel
          config={makeOpcuaClientConfig()}
          connected={true}
          onSave={vi.fn()}
          onStatusChange={onStatusChange}
        />,
      );

      expect(screen.queryByRole('button', { name: /^Connect/ })).toBeNull();
      const disconnectButton = screen.getByRole('button', { name: 'Disconnect' });
      fireEvent.click(disconnectButton);
      await act(() => vi.advanceTimersByTimeAsync(0));

      expect(mockedApiJson).toHaveBeenCalledWith(
        '/api/datasources/PLC/stop',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(screen.getByRole('button', { name: 'Disconnecting…' })).toBeDisabled();
      expect(onStatusChange).toHaveBeenCalledTimes(1);

      await act(() => vi.advanceTimersByTimeAsync(1999));
      expect(screen.getByRole('button', { name: 'Disconnecting…' })).toBeDisabled();
      expect(onStatusChange).toHaveBeenCalledTimes(1);

      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(onStatusChange).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled();
    });

    it('keeps showing Disconnecting… (not Connect) if the immediate status refresh flips `connected` to false mid-click', async () => {
      // Regression: disconnect resolves fast enough that the panel's own
      // onStatusChange() call can pull `connected: false` from the parent
      // before the 2000ms busy window ends. The button must stay pinned to
      // the action in flight instead of flipping back to "Connect".
      mockedApiJson.mockResolvedValue(undefined);
      const onStatusChange = vi.fn();

      const { rerender } = render(
        <DatasourcePropertiesPanel
          config={makeOpcuaClientConfig()}
          connected={true}
          onSave={vi.fn()}
          onStatusChange={onStatusChange}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
      await act(() => vi.advanceTimersByTimeAsync(0));

      // Simulate the parent re-rendering with the now-disconnected status
      // after the immediate onStatusChange() call above.
      rerender(
        <DatasourcePropertiesPanel
          config={makeOpcuaClientConfig()}
          connected={false}
          onSave={vi.fn()}
          onStatusChange={onStatusChange}
        />,
      );

      expect(screen.getByRole('button', { name: 'Disconnecting…' })).toBeDisabled();
      expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
    });

    it('hides a stale connection error immediately on click, even if the refreshed status still carries an error', async () => {
      mockedApiJson.mockResolvedValue(undefined);

      render(
        <DatasourcePropertiesPanel
          config={makeOpcuaClientConfig()}
          connected={false}
          statusError="[Errno 61] Connection refused"
          onSave={vi.fn()}
          onStatusChange={vi.fn()}
        />,
      );

      expect(screen.getByRole('alert')).toHaveTextContent('[Errno 61] Connection refused');

      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
      await act(() => vi.advanceTimersByTimeAsync(0));

      // The parent hasn't re-rendered with fresh props yet (statusError prop
      // is still the stale value) — the panel must hide it locally anyway.
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('clears its settle timeout on unmount', async () => {
      mockedApiJson.mockResolvedValue(undefined);
      const onStatusChange = vi.fn();

      const { unmount } = render(
        <DatasourcePropertiesPanel
          config={makeOpcuaClientConfig()}
          connected={true}
          onSave={vi.fn()}
          onStatusChange={onStatusChange}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(onStatusChange).toHaveBeenCalledTimes(1);

      unmount();

      await act(() => vi.advanceTimersByTimeAsync(2000));

      expect(onStatusChange).toHaveBeenCalledTimes(1);
    });

    it('does not carry a pending connect over to the next datasource', async () => {
      mockedApiJson.mockResolvedValue(undefined);
      const onStatusChange = vi.fn();

      const { rerender } = render(
        <DatasourcePropertiesPanel
          config={makeOpcuaClientConfig()}
          connected={false}
          onSave={vi.fn()}
          onStatusChange={onStatusChange}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByRole('button', { name: 'Connecting…' })).toBeDisabled();

      // The panel is reused across a datasource switch — same component, new
      // config — so a pending settle would otherwise land on the new selection.
      const other = { ...makeOpcuaClientConfig(), name: 'PLC2' };
      await act(async () => {
        rerender(
          <DatasourcePropertiesPanel
            config={other}
            connected={false}
            statusError="[Errno 61] Connection refused"
            onSave={vi.fn()}
            onStatusChange={onStatusChange}
          />,
        );
      });

      expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();
      expect(screen.getByRole('alert')).toHaveTextContent('[Errno 61] Connection refused');

      await act(() => vi.advanceTimersByTimeAsync(2000));

      expect(onStatusChange).toHaveBeenCalledTimes(1);
    });
  });

  describe('CertificateControls', () => {
    it('disables both buttons when security policy is NoSecurity', () => {
      render(
        <DatasourcePropertiesPanel
          config={makeOpcuaClientConfig()}
          connected={false}
          onSave={vi.fn()}
        />,
      );

      expect(screen.getByRole('button', { name: 'Generate certificate…' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Certificate info' })).toBeDisabled();
    });

    it('keeps Certificate info disabled until a certificate path is set', () => {
      const config = makeOpcuaClientConfig();
      config.settings = { ...config.settings, security_policy: 'Basic256Sha256' };

      render(<DatasourcePropertiesPanel config={config} connected={false} onSave={vi.fn()} />);

      expect(screen.getByRole('button', { name: 'Generate certificate…' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Certificate info' })).toBeDisabled();
    });

    it('enables Certificate info once a certificate path is set', () => {
      const config = makeOpcuaClientConfig();
      config.settings = {
        ...config.settings,
        security_policy: 'Basic256Sha256',
        client_certificate: 'certs/plc-cert.pem',
      };

      render(<DatasourcePropertiesPanel config={config} connected={false} onSave={vi.fn()} />);

      expect(screen.getByRole('button', { name: 'Certificate info' })).toBeEnabled();
    });

    it('generates a cert pair for the datasource name and populates cert, key and clears the key password', async () => {
      mockedApiJson.mockResolvedValue({
        client_certificate: 'certs/generated.pem',
        client_private_key: 'certs/generated.key',
      });

      const config = makeOpcuaClientConfig();
      config.settings = {
        ...config.settings,
        security_policy: 'Basic256Sha256',
        client_private_key_password: 'secret',
      };

      render(<DatasourcePropertiesPanel config={config} connected={false} onSave={vi.fn()} />);

      fireEvent.click(screen.getByRole('button', { name: 'Generate certificate…' }));
      fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
      await act(() => vi.advanceTimersByTimeAsync(0));

      expect(mockedApiJson).toHaveBeenCalledWith('/api/datasources/certs/generate', {
        method: 'POST',
        body: { name: 'PLC', common_name: 'PLC', validity_days: 3650 },
      });
      expect(screen.getByPlaceholderText('certs/client-cert.pem')).toHaveValue(
        'certs/generated.pem',
      );
      expect(screen.getByPlaceholderText('certs/client-key.pem')).toHaveValue(
        'certs/generated.key',
      );
      expect(screen.getByPlaceholderText('Optional')).toHaveValue('');
    });

    it('shows the certificate lifecycle when Certificate info is clicked', async () => {
      mockedApiJson.mockResolvedValue({
        readable: true,
        subject: 'CN=plc',
        fingerprint: 'ab'.repeat(32),
        issuedAt: '2026-01-01T00:00:00+00:00',
        expiresAt: '2036-01-01T00:00:00+00:00',
        expiresInDays: 3650,
        expired: false,
        expiring: false,
        selfSigned: true,
        names: ['localhost'],
      });

      const config = makeOpcuaClientConfig();
      config.settings = {
        ...config.settings,
        security_policy: 'Basic256Sha256',
        client_certificate: 'certs/plc-cert.pem',
      };

      render(<DatasourcePropertiesPanel config={config} connected={false} onSave={vi.fn()} />);

      fireEvent.click(screen.getByRole('button', { name: 'Certificate info' }));
      await act(() => vi.advanceTimersByTimeAsync(0));

      expect(mockedApiJson).toHaveBeenCalledWith(
        '/api/datasources/certs/info?path=certs%2Fplc-cert.pem',
      );
      expect(screen.getByText('Valid — 3650 days left')).toBeInTheDocument();
    });
  });

  describe('server certificate', () => {
    const presented = {
      status: 'untrusted',
      subject: 'CN=plc-1500',
      issuer: 'CN=plant-ca',
      expiresAt: '2036-01-01T00:00:00+00:00',
      fingerprint: 'ab'.repeat(32),
    };

    function securedClient(username = 'operator'): DatasourceConfig {
      const config = makeOpcuaClientConfig();
      config.settings = { ...config.settings, security_policy: 'Basic256Sha256', username };
      return config;
    }

    it('shows what the server presented and pins exactly that fingerprint on Trust', async () => {
      const config = securedClient();
      useVariablesDomainStore.setState({ selectedConfig: config });
      mockedApiJson
        .mockResolvedValueOnce(presented)
        .mockResolvedValueOnce({ server_certificate: 'certs/PLC-server.der' });
      const onStatusChange = vi.fn();

      render(
        <DatasourcePropertiesPanel
          config={config}
          connected={false}
          certificateStatus="untrusted"
          onSave={vi.fn()}
          onStatusChange={onStatusChange}
        />,
      );
      await act(() => vi.advanceTimersByTimeAsync(0));

      expect(mockedApiJson).toHaveBeenCalledWith('/api/datasources/PLC/server-certificate');
      expect(screen.getByText('CN=plc-1500')).toBeInTheDocument();
      expect(screen.getByText('CN=plant-ca')).toBeInTheDocument();
      expect(screen.getByText(Array(16).fill('abab').join(' '))).toBeInTheDocument();
      expect(
        screen.getByText(/username and password are sent only after you trust this certificate/),
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Trust certificate' }));
      await act(() => vi.advanceTimersByTimeAsync(0));

      expect(mockedApiJson).toHaveBeenLastCalledWith(
        '/api/datasources/PLC/server-certificate/trust',
        { method: 'POST', body: { fingerprint: 'ab'.repeat(32) } },
      );
      expect(useVariablesDomainStore.getState().selectedConfig?.settings).toMatchObject({
        server_certificate: 'certs/PLC-server.der',
      });
      expect(onStatusChange).toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: 'Trust certificate' })).toBeNull();
    });

    it('keeps an unsaved settings draft from unpinning the certificate on save', async () => {
      const config = securedClient();
      useVariablesDomainStore.setState({
        selectedConfig: config,
        propsDrafts: { PLC: { ...config.settings, reconnect_interval_s: 9 } },
      });
      mockedApiJson
        .mockResolvedValueOnce(presented)
        .mockResolvedValueOnce({ server_certificate: 'certs/PLC-server.der' });

      render(
        <DatasourcePropertiesPanel
          config={config}
          connected={false}
          certificateStatus="untrusted"
          onSave={vi.fn()}
        />,
      );
      await act(() => vi.advanceTimersByTimeAsync(0));
      fireEvent.click(screen.getByRole('button', { name: 'Trust certificate' }));
      await act(() => vi.advanceTimersByTimeAsync(0));

      expect(useVariablesDomainStore.getState().propsDrafts.PLC).toMatchObject({
        reconnect_interval_s: 9,
        server_certificate: 'certs/PLC-server.der',
      });
    });

    it('warns in danger colours when the certificate changed', async () => {
      mockedApiJson.mockResolvedValueOnce({ ...presented, status: 'changed' });

      render(
        <DatasourcePropertiesPanel
          config={securedClient()}
          connected={false}
          certificateStatus="changed"
          onSave={vi.fn()}
        />,
      );
      await act(() => vi.advanceTimersByTimeAsync(0));

      const alert = screen.getByRole('alert');
      expect(alert).toHaveClass('cfg-error-banner');
      expect(alert).toHaveTextContent('changed since you trusted it');
    });

    it('shows why a trust was refused', async () => {
      mockedApiJson
        .mockResolvedValueOnce(presented)
        .mockRejectedValueOnce(new Error('The server presents a different certificate now.'));

      render(
        <DatasourcePropertiesPanel
          config={securedClient()}
          connected={false}
          certificateStatus="untrusted"
          onSave={vi.fn()}
        />,
      );
      await act(() => vi.advanceTimersByTimeAsync(0));
      fireEvent.click(screen.getByRole('button', { name: 'Trust certificate' }));
      await act(() => vi.advanceTimersByTimeAsync(0));

      expect(
        screen.getByText('The server presents a different certificate now.'),
      ).toBeInTheDocument();
    });

    it('says why the connection is held once, in the card rather than the header', async () => {
      mockedApiJson.mockResolvedValueOnce({ ...presented, status: 'changed' });

      render(
        <DatasourcePropertiesPanel
          config={securedClient()}
          connected={false}
          statusError="The server certificate changed since it was trusted."
          certificateStatus="changed"
          onSave={vi.fn()}
        />,
      );
      await act(() => vi.advanceTimersByTimeAsync(0));

      expect(screen.getAllByRole('alert')).toHaveLength(1);
      expect(screen.getByRole('alert').closest('.cfg-panel-header')).toBeNull();
      expect(screen.queryByText(/changed since it was trusted/)).toBeNull();
    });

    it('folds the card to a Review row on Not now, and fetches nothing once trusted', async () => {
      mockedApiJson.mockResolvedValueOnce(presented);
      const { rerender } = render(
        <DatasourcePropertiesPanel
          config={securedClient('')}
          connected={true}
          certificateStatus="untrusted"
          onSave={vi.fn()}
        />,
      );
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByText(/cannot tell the PLC from an impostor/)).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
      expect(screen.getByText('Server certificate')).toBeInTheDocument();
      expect(screen.getByText('Not trusted yet.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Trust certificate' })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Review certificate' }));
      expect(screen.getByRole('button', { name: 'Trust certificate' })).toBeInTheDocument();
      expect(mockedApiJson).toHaveBeenCalledTimes(1);

      mockedApiJson.mockClear();
      rerender(
        <DatasourcePropertiesPanel
          config={securedClient('')}
          connected={true}
          certificateStatus="trusted"
          onSave={vi.fn()}
        />,
      );
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(mockedApiJson).not.toHaveBeenCalled();
    });
  });

  describe('test server reach', () => {
    it('states where a running test server listens', () => {
      render(
        <DatasourcePropertiesPanel
          config={makeTestServerConfig()}
          connected={true}
          onSave={vi.fn()}
        />,
      );

      expect(screen.getByText('opc.tcp://127.0.0.1:4855/nexthmi/test/')).toBeInTheDocument();
      expect(
        screen.getByText('Anonymous only. Writes follow each node\u2019s access level.'),
      ).toBeInTheDocument();
    });

    it('warns once the server is made reachable from the network', () => {
      render(
        <DatasourcePropertiesPanel
          config={makeTestServerConfig()}
          connected={false}
          onSave={vi.fn()}
        />,
      );
      const warning = /Every device on the network can connect to this test server/;
      expect(screen.queryByText(warning)).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'On' }));

      expect(screen.getByText(warning)).toBeInTheDocument();
      expect(useVariablesDomainStore.getState().propsDrafts.TestServer).toMatchObject({
        reachable_from_network: true,
      });
    });

    it('names the address this page came from for a server reachable from the network', () => {
      vi.stubGlobal('location', { hostname: '192.168.10.20' });
      const config = makeTestServerConfig();
      config.settings = { ...config.settings, reachable_from_network: true };

      render(<DatasourcePropertiesPanel config={config} connected={true} onSave={vi.fn()} />);

      expect(screen.getByText('opc.tcp://192.168.10.20:4855/nexthmi/test/')).toBeInTheDocument();
    });

    it('stands in for the device address when the page came over loopback', () => {
      vi.stubGlobal('location', { hostname: 'localhost' });
      const config = makeTestServerConfig();
      config.settings = { ...config.settings, reachable_from_network: true };

      render(<DatasourcePropertiesPanel config={config} connected={true} onSave={vi.fn()} />);

      expect(
        screen.getByText('opc.tcp://<this device\u2019s address>:4855/nexthmi/test/'),
      ).toBeInTheDocument();
    });
  });

  describe('connect-error placement', () => {
    it('renders the status error inside the panel header, above the Control divider', () => {
      render(
        <DatasourcePropertiesPanel
          config={makeOpcuaClientConfig()}
          connected={false}
          statusError="Connection timed out"
          onSave={vi.fn()}
        />,
      );

      const error = screen.getByRole('alert');
      const connectButton = screen.getByRole('button', { name: 'Connect' });
      expect(error.closest('.cfg-panel-header')).not.toBeNull();
      expect(error.closest('.cfg-section')).toBeNull(); // not nested inside Control
      expect(
        error.compareDocumentPosition(connectButton) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(error).toHaveTextContent('Connection timed out');
    });

    it('renders the status error inside the panel header for a test server too', () => {
      render(
        <DatasourcePropertiesPanel
          config={makeTestServerConfig()}
          connected={false}
          statusError="Port already in use"
          onSave={vi.fn()}
        />,
      );

      const error = screen.getByRole('alert');
      const startButton = screen.getByRole('button', { name: 'Start' });
      expect(error.closest('.cfg-panel-header')).not.toBeNull();
      expect(error.closest('.cfg-section')).toBeNull();
      expect(
        error.compareDocumentPosition(startButton) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(error).toHaveTextContent('Port already in use');
    });

    it('does not render an error while connected', () => {
      render(
        <DatasourcePropertiesPanel
          config={makeOpcuaClientConfig()}
          connected={true}
          statusError="Connection timed out"
          onSave={vi.fn()}
        />,
      );

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });
});
