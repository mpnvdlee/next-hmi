import { create } from 'zustand';
import { withBase } from '@shared/utils/runtimeBase';

/**
 * Cached client device info fetched once per HMI session from /api/device/info.
 * Read by the $device expression source via useEvalContext.
 *
 * Lookups are best-effort on the backend — any field may be null when reverse-DNS
 * has no PTR record or the client isn't on the server's L2 segment for ARP.
 */

interface DeviceInfo {
  hostname: string | null;
  ipAddress: string | null;
  macAddress: string | null;
}

interface DeviceInfoStore {
  info: DeviceInfo | null;
  loaded: boolean;
  fetch: () => Promise<void>;
}

let inFlight: Promise<void> | null = null;

export const useDeviceInfoStore = create<DeviceInfoStore>((set, get) => ({
  info: null,
  loaded: false,

  fetch: () => {
    if (get().loaded) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const resp = await fetch(withBase('/api/device/info'));
        if (!resp.ok) {
          set({ loaded: true, info: { hostname: null, ipAddress: null, macAddress: null } });
          return;
        }
        const body = (await resp.json()) as {
          ip: string | null;
          hostname: string | null;
          mac: string | null;
        };
        set({
          loaded: true,
          info: {
            hostname: body.hostname ?? null,
            ipAddress: body.ip ?? null,
            macAddress: body.mac ?? null,
          },
        });
      } catch {
        set({ loaded: true, info: { hostname: null, ipAddress: null, macAddress: null } });
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  },
}));
