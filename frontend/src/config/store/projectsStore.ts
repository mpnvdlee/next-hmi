import { create } from 'zustand';
import { apiErrorFrom, apiJson, isApiError } from '@shared/utils/api';
import { withBase } from '@shared/utils/runtimeBase';

export interface ProjectEntry {
  id: string;
  name: string;
  path: string;
  addedAt: string;
  lastOpenedAt: string | null;
  status: 'present' | 'missing';
  /** The project the origin root (`/`) resolves to. Chosen on the Projects page. */
  isDefault: boolean;
  /** Whether the workspace MCP may write to this project. Controlled from the
   * manager dashboard; the per-project admin page no longer owns this. */
  mcpEnabled: boolean;
  /** Fresh seeded projects remain inaccessible until the manager creates the
   * initial admin operator credential. */
  operatorSetupRequired: boolean;
  operatorSetupStatus: 'required' | 'complete' | 'error';
  operatorSetupError: string | null;
}

export type PeerScheme = 'http' | 'https';

export interface DiscoveredPeer {
  name: string;
  host: string;
  port: number;
  scheme: PeerScheme;
  runtimeId?: string;
  addresses?: string[];
  source: 'mdns' | 'manual';
  addedAt?: string;
}

interface PeerListResponse {
  discovered: DiscoveredPeer[];
  manual: DiscoveredPeer[];
  ownRuntimeId: string;
}

interface ProjectsListResponse {
  defaultProjectId: string | null;
  defaultProjectsRoot: string | null;
  projects: ProjectEntry[];
}

interface RuntimeHomeInfo {
  runtimeHome: string;
  defaultProjectsRoot: string;
}

interface ValidatePathResponse {
  ok: boolean;
  reason?: string;
  resolvedPath?: string;
  exists?: boolean;
  isEmpty?: boolean;
  parentWritable?: boolean;
}

export interface BrowseDirEntry {
  name: string;
  path: string;
}

export interface BrowseDirResponse {
  path: string;
  parent: string | null;
  entries: BrowseDirEntry[];
  error: string | null;
  hasConfigJson: boolean;
}

interface PeerTransferStatus {
  transferId: string;
  phase: string;
  status: 'active' | 'complete' | 'error' | 'cancelled';
  bytesDone: number;
  bytesTotal: number;
  message?: string | null;
}

interface ProjectsStore {
  projects: ProjectEntry[];
  defaultProjectId: string | null;
  defaultProjectsRoot: string | null;
  runtimeHome: string | null;
  loading: boolean;
  error: string | null;
  // Per-row mutation flag so the table can show a spinner next to the
  // active row without locking out the rest.
  busyProjectId: string | null;

  load(): Promise<void>;
  loadRuntimeHome(): Promise<void>;
  setDefault(id: string): Promise<void>;
  setupOperatorPassword(id: string, password: string): Promise<void>;
  validatePath(path: string): Promise<ValidatePathResponse>;
  browseDir(path?: string): Promise<BrowseDirResponse>;
  // Mutation actions throw on failure — callers (modals) display the error
  // locally. The store-level `error` is reserved for load failures shown in
  // the page header.
  createProject(name: string, path: string): Promise<ProjectEntry>;
  registerExisting(path: string, name?: string): Promise<ProjectEntry>;
  locate(id: string, path: string): Promise<ProjectEntry>;
  renameProject(id: string, patch: { name?: string; id?: string }): Promise<ProjectEntry>;
  removeProject(id: string, deleteFolder: boolean): Promise<void>;
  exportProject(id: string): void;
  importProject(file: File, destinationPath: string): Promise<ProjectEntry>;
  loadPeers(): Promise<PeerListResponse | null>;
  addManualPeer(host: string, port: number, name?: string, scheme?: PeerScheme): Promise<void>;
  removeManualPeer(host: string, port: number): Promise<void>;
  forgetPeerCertificate(host: string, port: number): Promise<void>;
  pairPeer(
    host: string,
    port: number,
    password: string,
    scheme?: PeerScheme,
  ): Promise<{ token: string; certificateFingerprint?: string }>;
  listPeerProjects(
    host: string,
    port: number,
    token: string,
    scheme?: PeerScheme,
  ): Promise<Array<{ id: string; name: string; folder: string; running: boolean }>>;
  beginPeerTransfer(args: {
    sourceProjectId: string;
    destinationProjectId: string;
    destinationFolder: string;
    peerHost: string;
    peerPort: number;
    peerScheme: PeerScheme;
    token: string;
    collisionPolicy: 'reject' | 'replace' | 'copy';
    confirmReplace: boolean;
    start: boolean;
    transferId: string;
  }): Promise<PeerTransferStatus>;
  getPeerTransfer(transferId: string): Promise<PeerTransferStatus>;
  cancelPeerTransfer(transferId: string): Promise<PeerTransferStatus>;
  beginPeerPull(args: {
    sourceProjectId: string;
    destinationProjectId: string;
    destinationFolder: string;
    peerHost: string;
    peerPort: number;
    peerScheme: PeerScheme;
    token: string;
    collisionPolicy: 'reject' | 'replace' | 'copy';
    confirmReplace: boolean;
    start: boolean;
    transferId: string;
  }): Promise<PeerTransferStatus>;
  getPeerPull(transferId: string): Promise<PeerTransferStatus>;
  cancelPeerPull(transferId: string): Promise<PeerTransferStatus>;
  clearError(): void;
}

export function describeError(e: unknown): string {
  if (isApiError(e)) return e.message;
  return e instanceof Error ? e.message : String(e);
}

export const useProjectsStore = create<ProjectsStore>((set, get) => ({
  projects: [],
  defaultProjectId: null,
  defaultProjectsRoot: null,
  runtimeHome: null,
  loading: false,
  error: null,
  busyProjectId: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const data = await apiJson<ProjectsListResponse>('/api/projects');
      set({
        projects: data.projects,
        defaultProjectId: data.defaultProjectId,
        defaultProjectsRoot: data.defaultProjectsRoot,
        loading: false,
      });
    } catch (e) {
      set({ loading: false, error: describeError(e) });
    }
  },

  setDefault: async (id: string) => {
    set({ busyProjectId: id });
    try {
      await apiJson(`/api/projects/${encodeURIComponent(id)}/default`, { method: 'POST' });
      await get().load();
    } finally {
      set({ busyProjectId: null });
    }
  },

  setupOperatorPassword: async (id: string, password: string) => {
    set({ busyProjectId: id });
    try {
      await apiJson(`/api/manager/projects/${encodeURIComponent(id)}/operator-setup`, {
        method: 'POST',
        body: { password },
      });
      await get().load();
    } finally {
      set({ busyProjectId: null });
    }
  },

  loadRuntimeHome: async () => {
    try {
      const info = await apiJson<RuntimeHomeInfo>('/api/projects/_runtime-home');
      set({ runtimeHome: info.runtimeHome, defaultProjectsRoot: info.defaultProjectsRoot });
    } catch (e) {
      // Non-fatal — used only to seed the new-project path field.
      console.warn('[projectsStore] loadRuntimeHome failed:', e);
    }
  },

  validatePath: async (path: string) => {
    try {
      return await apiJson<ValidatePathResponse>('/api/projects/validate-path', {
        method: 'POST',
        body: { path },
      });
    } catch (e) {
      return { ok: false, reason: describeError(e) };
    }
  },

  browseDir: async (path?: string) => {
    const query = path ? `?path=${encodeURIComponent(path)}` : '';
    return apiJson<BrowseDirResponse>(`/api/projects/browse-dir${query}`);
  },

  createProject: async (name: string, path: string) => {
    const entry = await apiJson<ProjectEntry>('/api/projects', {
      method: 'POST',
      body: { name, path },
    });
    await get().load();
    return entry;
  },

  registerExisting: async (path: string, name?: string) => {
    const entry = await apiJson<ProjectEntry>('/api/projects/register', {
      method: 'POST',
      body: { path, name: name?.trim() || undefined },
    });
    await get().load();
    return entry;
  },

  locate: async (id: string, path: string) => {
    set({ busyProjectId: id });
    try {
      const entry = await apiJson<ProjectEntry>(`/api/projects/${encodeURIComponent(id)}/locate`, {
        method: 'POST',
        body: { path },
      });
      await get().load();
      return entry;
    } finally {
      set({ busyProjectId: null });
    }
  },

  renameProject: async (id: string, patch: { name?: string; id?: string }) => {
    set({ busyProjectId: id });
    try {
      const entry = await apiJson<ProjectEntry>(`/api/projects/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: patch,
      });
      await get().load();
      return entry;
    } finally {
      set({ busyProjectId: null });
    }
  },

  exportProject: (id: string) => {
    // Hit the streaming endpoint via a hidden anchor so the browser uses the
    // server's Content-Disposition filename. No fetch round-trip into JS land.
    const a = document.createElement('a');
    a.href = withBase(`/api/projects/${encodeURIComponent(id)}/export`);
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  },

  importProject: async (file: File, destinationPath: string) => {
    const form = new FormData();
    form.append('file', file);
    form.append('destinationPath', destinationPath);
    const res = await fetch(withBase('/api/projects/import'), { method: 'POST', body: form });
    if (!res.ok) throw await apiErrorFrom(res);
    const entry = (await res.json()) as ProjectEntry;
    await get().load();
    return entry;
  },

  removeProject: async (id: string, deleteFolder: boolean) => {
    set({ busyProjectId: id });
    try {
      await apiJson(
        `/api/projects/${encodeURIComponent(id)}?deleteFolder=${deleteFolder ? 'true' : 'false'}`,
        { method: 'DELETE' },
      );
      await get().load();
    } finally {
      set({ busyProjectId: null });
    }
  },

  loadPeers: async () => {
    try {
      return await apiJson<PeerListResponse>('/api/manager/peers/discovered');
    } catch (e) {
      console.warn('[projectsStore] loadPeers failed:', e);
      return null;
    }
  },

  addManualPeer: async (host: string, port: number, name?: string, scheme: PeerScheme = 'http') => {
    await apiJson('/api/manager/peers/manual', {
      method: 'POST',
      body: { host, port, name, scheme },
    });
  },

  removeManualPeer: async (host: string, port: number) => {
    await apiJson(`/api/manager/peers/manual?host=${encodeURIComponent(host)}&port=${port}`, {
      method: 'DELETE',
    });
  },

  forgetPeerCertificate: async (host: string, port: number) => {
    await apiJson(`/api/manager/peers/trust?host=${encodeURIComponent(host)}&port=${port}`, {
      method: 'DELETE',
    });
  },

  pairPeer: async (host, port, password, scheme: PeerScheme = 'http') =>
    apiJson<{ token: string; certificateFingerprint?: string }>('/api/manager/peer-pair', {
      method: 'POST',
      body: { host, port, password, scheme },
    }),

  listPeerProjects: async (host, port, token, scheme: PeerScheme = 'http') => {
    const result = await apiJson<{
      projects: Array<{ id: string; name: string; folder: string; running: boolean }>;
    }>('/api/manager/peer-projects', { method: 'POST', body: { host, port, token, scheme } });
    return result.projects;
  },

  beginPeerTransfer: async (args) =>
    apiJson<PeerTransferStatus>('/api/manager/transfers', { method: 'POST', body: args }),

  getPeerTransfer: async (transferId) =>
    apiJson<PeerTransferStatus>(`/api/manager/transfers/${encodeURIComponent(transferId)}`),

  cancelPeerTransfer: async (transferId) =>
    apiJson<PeerTransferStatus>(`/api/manager/transfers/${encodeURIComponent(transferId)}`, {
      method: 'DELETE',
    }),

  beginPeerPull: async (args) =>
    apiJson<PeerTransferStatus>('/api/manager/pulls', { method: 'POST', body: args }),

  getPeerPull: async (transferId) =>
    apiJson<PeerTransferStatus>(`/api/manager/pulls/${encodeURIComponent(transferId)}`),

  cancelPeerPull: async (transferId) =>
    apiJson<PeerTransferStatus>(`/api/manager/pulls/${encodeURIComponent(transferId)}`, {
      method: 'DELETE',
    }),

  clearError: () => set({ error: null }),
}));
