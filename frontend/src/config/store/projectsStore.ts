import { create } from 'zustand';
import { apiErrorFrom, apiJson, errorMessage, managerApiJson } from '@shared/utils/api';
import { withBase } from '@shared/utils/runtimeBase';

export interface ProjectMigrationRecord {
  fromVersion: number;
  toVersion: number;
  at: string;
  /** Zip of the whole project taken before the migration touched anything.
   *  Null on a record written before this replaced the per-target backup map. */
  backup: string | null;
}

export interface ProjectEntry {
  id: string;
  name: string;
  path: string;
  addedAt: string;
  lastOpenedAt: string | null;
  status: 'present' | 'missing';
  /** Whether `path` is a direct child of the projects root — the only place a
   * peer transfer can ever install. Computed by the backend, which is the
   * only side that knows the root resolved the way `path` was stored. */
  inProjectsRoot: boolean;
  /** The project the origin root (`/`) resolves to. Chosen on the Projects page. */
  isDefault: boolean;
  /** Whether the workspace MCP may write to this project. Controlled from the
   * manager dashboard; the per-project admin page no longer owns this. */
  mcpEnabled: boolean;
  /** Whether the project's `users.json` is readable and well-formed. A project
   * whose document is broken cannot be started until it is repaired on disk. */
  credentialsStatus: 'ok' | 'error';
  credentialsError: string | null;
  /** The project's on-disk schema version — null when `status` is `missing`. */
  formatVersion: number | null;
  /** The release that stamped `formatVersion`, so a build too old to open this
   * project can name the version the operator needs. Null when the stamping
   * build predated the field. Display only — never parsed or compared. */
  minAppVersion: string | null;
  /** `formatVersion` is behind this build's baseline; starting it needs the
   * operator to confirm an upgrade first. */
  needsUpgrade: boolean;
  /** `formatVersion` is newer than this build supports; it cannot be started
   * until the application is updated. */
  unsupportedFormat: boolean;
  /** Set once this project has actually been migrated; kept around (even
   * after it is no longer the current format) as a pointer to the backup. */
  lastMigration: ProjectMigrationRecord | null;
  /** When the project's main-page thumbnail was last rasterised, or null if
   * the project has never been saved and so has no thumbnail yet. */
  thumbnailUpdatedAt: string | null;
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

/** One project a paired peer is willing to name, as that peer describes it. */
export interface PeerProject {
  id: string;
  name: string;
  folder: string;
  running: boolean;
  /**
   * Whether `folder` is a folder in the peer's *projects root*. Only the peer
   * knows where its root is, and a transfer can only ever install into it —
   * so a project registered anywhere else neither clashes with an incoming
   * folder nor can be replaced by one. Absent from a peer predating the field.
   */
  inProjectsRoot?: boolean;
}

export interface PeerTransferStatus {
  transferId: string;
  phase: string;
  /** The phase that was running when it failed; `phase` holds the outcome. */
  failedPhase?: string | null;
  // The last two only ever reach a client that is *installing*: the pull
  // journal and the receiver's own status endpoint produce them. A sender's
  // journal never leaves active/complete/error/cancelled.
  status:
    'active' | 'complete' | 'error' | 'cancelled' | 'applied_pending_start' | 'recovery_required';
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
  validatePath(path: string): Promise<ValidatePathResponse>;
  browseDir(path?: string): Promise<BrowseDirResponse>;
  // Mutation actions throw on failure — callers (modals) display the error
  // locally. The store-level `error` is reserved for load failures shown in
  // the page header.
  createProject(name: string, path: string, template?: 'empty' | 'example'): Promise<ProjectEntry>;
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
  ): Promise<PeerProject[]>;
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
  // `errorMessage` already maps a failed `fetch`'s bare TypeError to
  // something an operator can read; duplicating that mapping here is how a
  // raw "Failed to fetch" reached the transfer failure panel.
  return errorMessage(e);
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

  createProject: async (name: string, path: string, template: 'empty' | 'example' = 'empty') => {
    const entry = await apiJson<ProjectEntry>('/api/projects', {
      method: 'POST',
      body: { name, path, template },
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
      return await managerApiJson<PeerListResponse>('/api/manager/peers/discovered');
    } catch (e) {
      console.warn('[projectsStore] loadPeers failed:', e);
      return null;
    }
  },

  addManualPeer: async (host: string, port: number, name?: string, scheme: PeerScheme = 'http') => {
    await managerApiJson('/api/manager/peers/manual', {
      method: 'POST',
      body: { host, port, name, scheme },
    });
  },

  removeManualPeer: async (host: string, port: number) => {
    await managerApiJson(
      `/api/manager/peers/manual?host=${encodeURIComponent(host)}&port=${port}`,
      {
        method: 'DELETE',
      },
    );
  },

  forgetPeerCertificate: async (host: string, port: number) => {
    await managerApiJson(`/api/manager/peers/trust?host=${encodeURIComponent(host)}&port=${port}`, {
      method: 'DELETE',
    });
  },

  pairPeer: async (host, port, password, scheme: PeerScheme = 'http') =>
    managerApiJson<{ token: string; certificateFingerprint?: string }>('/api/manager/peer-pair', {
      method: 'POST',
      body: { host, port, password, scheme },
    }),

  listPeerProjects: async (host, port, token, scheme: PeerScheme = 'http') => {
    const result = await managerApiJson<{ projects: PeerProject[] }>('/api/manager/peer-projects', {
      method: 'POST',
      body: { host, port, token, scheme },
    });
    return result.projects;
  },

  beginPeerTransfer: async (args) =>
    managerApiJson<PeerTransferStatus>('/api/manager/transfers', { method: 'POST', body: args }),

  getPeerTransfer: async (transferId) =>
    managerApiJson<PeerTransferStatus>(`/api/manager/transfers/${encodeURIComponent(transferId)}`),

  cancelPeerTransfer: async (transferId) =>
    managerApiJson<PeerTransferStatus>(`/api/manager/transfers/${encodeURIComponent(transferId)}`, {
      method: 'DELETE',
    }),

  beginPeerPull: async (args) =>
    managerApiJson<PeerTransferStatus>('/api/manager/pulls', { method: 'POST', body: args }),

  getPeerPull: async (transferId) =>
    managerApiJson<PeerTransferStatus>(`/api/manager/pulls/${encodeURIComponent(transferId)}`),

  cancelPeerPull: async (transferId) =>
    managerApiJson<PeerTransferStatus>(`/api/manager/pulls/${encodeURIComponent(transferId)}`, {
      method: 'DELETE',
    }),

  clearError: () => set({ error: null }),
}));
