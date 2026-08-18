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

  describe('ReconnectButton', () => {
    it('shows Reconnecting… while in flight, then reverts and refreshes status after the 2000ms delay', async () => {
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

      const reconnectButton = screen.getByRole('button', { name: 'Reconnect' });
      fireEvent.click(reconnectButton);
      await act(() => vi.advanceTimersByTimeAsync(0));

      expect(mockedApiJson).toHaveBeenCalledWith(
        '/api/datasources/PLC/restart',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(screen.getByRole('button', { name: 'Reconnecting…' })).toBeDisabled();
      expect(onStatusChange).not.toHaveBeenCalled();

      await act(() => vi.advanceTimersByTimeAsync(1999));
      expect(screen.getByRole('button', { name: 'Reconnecting…' })).toBeDisabled();
      expect(onStatusChange).not.toHaveBeenCalled();

      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(onStatusChange).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: 'Reconnect' })).toBeEnabled();
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

      fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(onStatusChange).not.toHaveBeenCalled();

      unmount();

      await act(() => vi.advanceTimersByTimeAsync(2000));

      expect(onStatusChange).toHaveBeenCalledTimes(1);
    });
  });
});
