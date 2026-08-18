import { create } from 'zustand';
import { enterpriseSessionResets } from '@enterprise';
import { apiErrorFrom, apiJson } from '@shared/utils/api';
import { withBase } from '@shared/utils/runtimeBase';
import { describeError, useProjectsStore } from '@config/store/projectsStore';
import type { SystemInfo } from '@config/components/admin/SystemInfoSection';
import type { TlsMode, TlsStatus } from '@config/components/admin/HttpsSection';
import type { TelemetryStatus } from '@config/components/admin/TelemetrySection';

/**
 * Manager-side state: device-admin auth and the supervisor's running set.
 * Project CRUD stays in the existing `projectsStore`.
 */

type InstanceStatus = 'starting' | 'running' | 'stopped' | 'crashed';

export interface InstanceSnapshot {
  id: string;
  name: string;
  path: string;
  basePath: string;
  port: number | null;
  pid: number | null;
  status: InstanceStatus;
  startedAt: number | null;
  restarts: number;
  lastError: string | null;
}

type AuthState = 'loading' | 'needs-setup' | 'needs-login' | 'authed';

interface ManagerStore {
  auth: AuthState;
  authError: string | null;
  instances: Record<string, InstanceSnapshot>;
  systemInfo: SystemInfo | null;

  refreshAuth(): Promise<void>;
  setup(password: string): Promise<void>;
  login(password: string): Promise<void>;
  logout(): Promise<void>;
  changePassword(currentPassword: string, newPassword: string): Promise<void>;

  refreshRunning(): Promise<void>;
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  setProjectMcp(id: string, enabled: boolean): Promise<void>;

  loadSystemInfo(): Promise<void>;

  tls: TlsStatus | null;
  loadTls(): Promise<void>;
  applyTls(enabled: boolean, mode: TlsMode): Promise<void>;
  regenerateTlsCertificate(): Promise<void>;
  uploadTlsCertificate(certificate: File, privateKey: File): Promise<void>;
  restartForTls(): Promise<void>;

  telemetry: TelemetryStatus | null;
  loadTelemetry(): Promise<void>;
  applyTelemetry(enabled: boolean): Promise<void>;
}

export const useManagerStore = create<ManagerStore>((set, get) => ({
  auth: 'loading',
  authError: null,
  instances: {},
  systemInfo: null,

  refreshAuth: async () => {
    try {
      const status = await apiJson<{ passwordSet: boolean; authenticated: boolean }>(
        '/api/manager/auth/status',
      );
      set({
        auth: status.authenticated ? 'authed' : status.passwordSet ? 'needs-login' : 'needs-setup',
        authError: null,
      });
    } catch (e) {
      set({ auth: 'needs-login', authError: describeError(e) });
    }
  },

  setup: async (password: string) => {
    await apiJson('/api/manager/auth/setup', { method: 'POST', body: { password } });
    set({ auth: 'authed', authError: null });
  },

  login: async (password: string) => {
    try {
      await apiJson('/api/manager/auth/login', { method: 'POST', body: { password } });
      set({ auth: 'authed', authError: null });
    } catch (e) {
      set({ authError: describeError(e) });
      throw e;
    }
  },

  logout: async () => {
    await apiJson('/api/manager/auth/logout', { method: 'POST' });
    set({ auth: 'needs-login', instances: {} });
    // Stores contributed through the edition seam hold device state of their
    // own that this one cannot name; they clear themselves here so signing out
    // is exhaustive rather than exhaustive-for-core.
    for (const reset of enterpriseSessionResets) reset();
  },

  changePassword: async (currentPassword: string, newPassword: string) => {
    await apiJson('/api/manager/auth/change-password', {
      method: 'POST',
      body: { currentPassword, newPassword },
    });
  },

  refreshRunning: async () => {
    const res = await apiJson<{ instances: InstanceSnapshot[] }>('/api/manager/running');
    const byId: Record<string, InstanceSnapshot> = {};
    for (const inst of res.instances) byId[inst.id] = inst;
    set({ instances: byId });
  },

  start: async (id: string) => {
    await apiJson(`/api/manager/projects/${encodeURIComponent(id)}/start`, { method: 'POST' });
    await get().refreshRunning();
  },

  stop: async (id: string) => {
    await apiJson(`/api/manager/projects/${encodeURIComponent(id)}/stop`, { method: 'POST' });
    await get().refreshRunning();
  },

  setProjectMcp: async (id: string, enabled: boolean) => {
    await apiJson(`/api/projects/${encodeURIComponent(id)}/mcp`, {
      method: 'POST',
      body: { enabled },
    });
    // The flag lives in the manifest-backed projects list, so refresh it.
    await useProjectsStore.getState().load();
  },

  loadSystemInfo: async () => {
    try {
      set({ systemInfo: await apiJson<SystemInfo>('/api/system/info') });
    } catch {
      // supervisor may be momentarily unreachable — ignore silently
    }
  },

  tls: null,

  loadTls: async () => {
    set({ tls: await apiJson<TlsStatus>('/api/system/tls') });
  },

  applyTls: async (enabled: boolean, mode: TlsMode) => {
    set({
      tls: await apiJson<TlsStatus>('/api/system/tls', {
        method: 'POST',
        body: { enabled, mode },
      }),
    });
  },

  regenerateTlsCertificate: async () => {
    set({ tls: await apiJson<TlsStatus>('/api/system/tls/certificate', { method: 'POST' }) });
  },

  uploadTlsCertificate: async (certificate: File, privateKey: File) => {
    const form = new FormData();
    form.append('certificate', certificate);
    form.append('privateKey', privateKey);
    const res = await fetch(withBase('/api/system/tls/certificate/custom'), {
      method: 'PUT',
      body: form,
    });
    if (!res.ok) throw await apiErrorFrom(res);
    set({ tls: (await res.json()) as TlsStatus });
  },

  restartForTls: async () => {
    await apiJson('/api/system/tls/restart', { method: 'POST' });
  },

  telemetry: null,

  loadTelemetry: async () => {
    set({ telemetry: await apiJson<TelemetryStatus>('/api/system/telemetry') });
  },

  applyTelemetry: async (enabled: boolean) => {
    set({
      telemetry: await apiJson<TelemetryStatus>('/api/system/telemetry', {
        method: 'PUT',
        body: { enabled },
      }),
    });
  },
}));
