import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PairedDevices from './PairedDevices';
import { listPairedDevices, revokePairedDevice, type PairedDevice } from './tokensApi';

vi.mock('./tokensApi', () => ({
  listPairedDevices: vi.fn(),
  revokePairedDevice: vi.fn(),
}));

const DAY_MS = 24 * 60 * 60 * 1000;

function inDays(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString();
}

function device(overrides: Partial<PairedDevice> = {}): PairedDevice {
  return {
    id: 'pair-a',
    hostname: 'hmi-line4',
    runtimeId: 'rt-7f3a9c',
    address: '192.168.1.31',
    createdAt: '2026-11-03T08:00:00Z',
    lastUsedAt: '2026-11-09T09:12:00Z',
    expiresAt: inDays(80),
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

it('lists each paired device with what identifies it and when it expires', async () => {
  vi.mocked(listPairedDevices).mockResolvedValue([
    device(),
    device({
      id: 'pair-b',
      hostname: null,
      runtimeId: null,
      address: '192.168.1.140',
      lastUsedAt: null,
      expiresAt: inDays(9 - 0.01),
    }),
  ]);
  render(<PairedDevices />);

  expect(
    screen.getByText(
      'These devices can send projects to this device and fetch projects from it without the device-admin password. A pairing expires after 90 days without use. Revoke it to cut access off at once.',
    ),
  ).toBeInTheDocument();
  const known = (await screen.findByText('hmi-line4')).closest('tr') as HTMLElement;
  expect(within(known).getByText('rt-7f3a9c · 192.168.1.31')).toBeInTheDocument();
  const knownExpiry = within(known).getByText(new Date(device().expiresAt).toLocaleDateString());
  expect(knownExpiry).not.toHaveClass('cfg-tokens-paired__expiring');

  const unknown = screen.getByText('Unknown device').closest('tr') as HTMLElement;
  expect(within(unknown).getByText('192.168.1.140')).toBeInTheDocument();
  expect(within(unknown).getByText('Never')).toBeInTheDocument();
  expect(within(unknown).getByText('in 9 days')).toHaveClass('cfg-tokens-paired__expiring');
});

it('revokes a device by name', async () => {
  const user = userEvent.setup();
  vi.mocked(listPairedDevices).mockResolvedValueOnce([device()]).mockResolvedValue([]);
  vi.mocked(revokePairedDevice).mockResolvedValue(undefined);
  render(<PairedDevices />);

  const revoke = await screen.findByRole('button', { name: /^Revoke hmi-line4, paired / });
  await act(() => user.click(revoke));

  expect(revokePairedDevice).toHaveBeenCalledWith('pair-a');
  await waitFor(() => expect(screen.queryByText('hmi-line4')).not.toBeInTheDocument());
  expect(screen.getByText('No paired devices.')).toBeInTheDocument();
});

it('says so when no device is paired', async () => {
  vi.mocked(listPairedDevices).mockResolvedValue([]);
  render(<PairedDevices />);

  expect(await screen.findByText('No paired devices.')).toBeInTheDocument();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
});
