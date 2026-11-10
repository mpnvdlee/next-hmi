import { useCallback, useEffect, useState } from 'react';
import Button from '../../ui/Button';
import { describeError } from '@config/store/projectsStore';
import { listPairedDevices, revokePairedDevice, type PairedDevice } from './tokensApi';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Closer than this, an expiry reads as a countdown in the warning colour. */
const EXPIRY_WARNING_DAYS = 14;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

function expiry(device: PairedDevice): { text: string; soon: boolean } {
  const days = Math.ceil((Date.parse(device.expiresAt) - Date.now()) / DAY_MS);
  if (days > EXPIRY_WARNING_DAYS) return { text: formatDate(device.expiresAt), soon: false };
  return { text: `in ${days} day${days === 1 ? '' : 's'}`, soon: true };
}

/**
 * The other NEXT HMI devices paired with this one for project transfer
 * (`/api/manager/peer-tokens`). Each can send and fetch projects without the
 * device-admin password until it is revoked here or goes 90 days unused.
 */
export default function PairedDevices() {
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setDevices(await listPairedDevices());
    } catch (e) {
      setError(describeError(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function revoke(id: string) {
    setBusy(true);
    setError(null);
    try {
      await revokePairedDevice(id);
      await refresh();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cfg-tokens-paired cfg-flex-col">
      <h3 className="cfg-tokens-paired__title">Paired devices</h3>
      <p className="cfg-admin-section__desc cfg-admin-section__desc--wide">
        These devices can send projects to this device and fetch projects from it without the
        device-admin password. A pairing expires after 90 days without use. Revoke it to cut access
        off at once.
      </p>

      {error && <p className="cfg-error-banner">{error}</p>}

      {devices.length === 0 ? (
        <p className="cfg-empty">No paired devices.</p>
      ) : (
        <table className="cfg-admin-table">
          <thead>
            <tr>
              <th>Device</th>
              <th>Paired</th>
              <th>Last used</th>
              <th>Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {devices.map((device) => {
              const name = device.hostname ?? 'Unknown device';
              const paired = formatDate(device.createdAt);
              const identity = [device.runtimeId, device.address].filter(Boolean).join(' · ');
              const expires = expiry(device);
              return (
                <tr key={device.id}>
                  <td>
                    <span className="cfg-tokens-device">{name}</span>
                    {identity && <code className="cfg-tokens-device__identity">{identity}</code>}
                  </td>
                  <td>{paired}</td>
                  <td>
                    {device.lastUsedAt ? new Date(device.lastUsedAt).toLocaleString() : 'Never'}
                  </td>
                  <td className={expires.soon ? 'cfg-tokens-paired__expiring' : undefined}>
                    {expires.text}
                  </td>
                  <td className="cfg-admin-table__actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      aria-label={`Revoke ${name}, paired ${paired}`}
                      onClick={() => void revoke(device.id)}
                    >
                      Revoke
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
