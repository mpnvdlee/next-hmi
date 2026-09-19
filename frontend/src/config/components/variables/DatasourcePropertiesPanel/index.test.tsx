import { render, screen, fireEvent, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVariablesDomainStore } from '@config/store/domains/variablesDomainStore';
import type { DatasourceConfig } from '@shared/types/datasource';
import { apiJson } from '@shared/utils/api';
import DatasourcePropertiesPanel from './index';

vi.mock('@shared/utils/api', () => ({ apiJson: vi.fn() }));

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

    it('does not clear its timeout on unmount, so onStatusChange still fires after the component is gone (leak)', async () => {
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

      expect(onStatusChange).toHaveBeenCalledTimes(1);
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

    it('does not clear its timeout on unmount, so onStatusChange still fires after the component is gone (leak)', async () => {
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

      expect(onStatusChange).toHaveBeenCalledTimes(2);
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
