import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdsClientSettings } from '@shared/types/datasource';
import { apiJson } from '@shared/utils/api';
import AdsSettingsForm, { type AdsLocalIdentity } from './index';

vi.mock('@shared/utils/api', () => ({ apiJson: vi.fn() }));

const mockedApiJson = vi.mocked(apiJson);

// jsdom doesn't implement scrollIntoView; the custom Select's popup calls it.
Element.prototype.scrollIntoView = vi.fn();

/** The form over its own settings state, as the dialog and panel hold it. */
function Harness({
  initial,
  identity,
}: {
  initial: Partial<AdsClientSettings>;
  identity?: AdsLocalIdentity;
}) {
  const [settings, setSettings] = useState<AdsClientSettings>({ host: '', ...initial });
  return (
    <>
      <AdsSettingsForm
        connectedIdentity={identity}
        settings={settings}
        onChange={(key, value) => setSettings((prev) => ({ ...prev, [key]: value }))}
      />
      <pre data-testid="settings">{JSON.stringify(settings)}</pre>
    </>
  );
}

function saved(): AdsClientSettings {
  return JSON.parse(screen.getByTestId('settings').textContent ?? '{}') as AdsClientSettings;
}

function field(label: string): HTMLInputElement {
  const row = screen.getByText(label, { selector: '.cfg-field-group__label, label, span' });
  const input = row.closest('.cfg-field-group')?.querySelector('input');
  if (!input) throw new Error(`no input for ${label}`);
  return input as HTMLInputElement;
}

describe('AdsSettingsForm', () => {
  beforeEach(() => {
    mockedApiJson.mockReset();
  });

  it('shows the basic and browse fields up front and the rest under Advanced', () => {
    render(<Harness initial={{ host: '192.168.1.10' }} />);

    expect(screen.getByText('PLC IP / Host')).toBeTruthy();
    expect(field('PLC AMS NetID').placeholder).toBe('192.168.1.10.1.1');
    expect(field('AMS Port').placeholder).toBe('851');
    expect(screen.getByText(/TwinCAT 2 uses 801/)).toBeTruthy();
    for (const label of ['Browse Root', 'Browse Mode', 'Browse Attributes']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(field('Browse Attributes').placeholder).toBe('OPC.UA.DA');
    fireEvent.change(field('Browse Root'), { target: { value: 'GVL_HMI' } });
    expect(saved().browse_root).toBe('GVL_HMI');
    expect(screen.queryByText("This HMI's AMS NetID")).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Advanced/ }));
    for (const label of [
      "This HMI's AMS NetID",
      'Local TwinCAT Router',
      'Connect Timeout (s)',
      'Request Timeout (s)',
      'Reconnect (s)',
      'Poll Interval (ms)',
      'Fast Max Delay (ms)',
      'Background Sync',
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    fireEvent.click(screen.getByRole('button', { name: /Advanced/ }));
  });

  it('tests the connection and shows the device, then this HMI’s route values', async () => {
    mockedApiJson.mockResolvedValue({
      ok: true,
      error: null,
      device_name: 'Plc30 App',
      version: '3.1.4024',
      ads_state: 'RUN',
      local_net_id: '10.0.0.5.1.1',
      local_ip: '10.0.0.5',
    });
    render(<Harness initial={{ host: '10.0.0.20', ams_net_id: '', route_password: 'secret' }} />);

    const values = [...document.querySelectorAll('.ds-ads__values dd')].map((d) => d.textContent);
    expect(values.slice(0, 2)).toEqual([
      'this HMI’s IP address followed by .1.1',
      'this HMI’s IP address',
    ]);
    expect(screen.getByText(/Run Test connection to fill in/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    expect(await screen.findByText(/Plc30 App · v3\.1\.4024 · ADS state RUN/)).toBeTruthy();
    const [url, init] = mockedApiJson.mock.calls[0];
    expect(url).toBe('/api/datasources/ads/test-connection');
    expect(init?.body).toMatchObject({ host: '10.0.0.20', local_router: false });
    expect(JSON.stringify(init?.body)).not.toContain('secret');
    // The TwinCAT route steps now name the tested values.
    expect(screen.getByText('10.0.0.5.1.1')).toBeTruthy();
    expect(screen.getByText('10.0.0.5')).toBeTruthy();
  });

  it('shows why a connection test failed', async () => {
    mockedApiJson.mockResolvedValue({ ok: false, error: 'No answer to ADS requests' });
    render(<Harness initial={{ host: '10.0.0.20' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect((await screen.findByRole('status')).textContent).toBe('✕ No answer to ADS requests');
  });

  it('offers no test while connected, since the PLC would refuse a second connection', () => {
    render(<AdsSettingsForm connected settings={{ host: '10.0.0.20' }} onChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Test connection' })).toBeNull();
    expect(screen.getByText(/Disconnect to test changed settings/)).toBeTruthy();
  });

  it('switches between the TwinCAT and the custom route', async () => {
    render(<Harness initial={{ host: '10.0.0.20' }} />);
    expect(screen.getByText(/Router → Edit Routes/)).toBeTruthy();
    expect(screen.queryByText('PLC Password')).toBeNull();
    // Route Method is the first select; Browse Mode follows it.
    const routeMethod = () => screen.getAllByRole('combobox')[0];

    fireEvent.click(routeMethod());
    fireEvent.click(await screen.findByRole('option', { name: 'Custom route' }));

    expect(saved().route_method).toBe('custom');
    expect(screen.queryByText(/Router → Edit Routes/)).toBeNull();
    expect(screen.getByText(/NEXT HMI asks the PLC to add the route/)).toBeTruthy();
    const password = field('PLC Password');
    expect(password.type).toBe('password');
    fireEvent.change(password, { target: { value: 'pw' } });
    fireEvent.change(field('PLC User'), { target: { value: 'Administrator' } });
    expect(saved().route_password).toBe('pw');

    // Back to a TwinCAT route: the PLC account is not kept with it.
    fireEvent.click(routeMethod());
    fireEvent.click(await screen.findByRole('option', { name: 'TwinCAT route' }));
    expect(saved().route_method).toBe('twincat');
    expect(saved()).not.toHaveProperty('route_password');
    expect(saved()).not.toHaveProperty('route_user');
  });

  it('fills the route steps in from a connected datasource', () => {
    render(
      <Harness
        initial={{ host: '10.0.0.20' }}
        identity={{ netId: '10.0.0.5.1.1', ip: '10.0.0.5' }}
      />,
    );
    expect(screen.getByText('10.0.0.5.1.1')).toBeTruthy();
    expect(screen.getByText('10.0.0.5')).toBeTruthy();
    expect(screen.queryByText(/Run Test connection to fill in/)).toBeNull();
  });

  it('creates the route on request and shows the result', async () => {
    mockedApiJson.mockResolvedValue({
      ok: true,
      error: null,
      route_name: 'panel-nexthmi',
      net_id: '10.0.0.5.1.1',
      address: '10.0.0.5',
    });
    render(
      <Harness initial={{ host: '10.0.0.20', route_method: 'custom', route_password: 'pw' }} />,
    );
    const create = screen.getByRole('button', { name: 'Create route now' });
    expect((create as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(field('PLC User'), { target: { value: 'Administrator' } });
    fireEvent.click(create);

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        '✓ Route “panel-nexthmi” created on the PLC for 10.0.0.5.1.1 at 10.0.0.5',
      ),
    );
    expect(mockedApiJson).toHaveBeenCalledWith('/api/datasources/ads/add-route', {
      method: 'POST',
      body: expect.objectContaining({ host: '10.0.0.20', user: 'Administrator', password: 'pw' }),
    });
  });

  it('says the local router owns the routes instead of offering them', () => {
    render(<Harness initial={{ host: '10.0.0.20', local_router: true }} />);
    expect(screen.getByText(/routes belong to that router/)).toBeTruthy();
    expect(screen.queryByText('Route Method')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create route now' })).toBeNull();
  });
});
