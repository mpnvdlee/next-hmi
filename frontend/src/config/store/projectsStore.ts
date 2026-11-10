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
  /** The code the project carries, by the peer's own account. Absent from a
   * peer predating the field: unknown, never "none". */
  code?: ProjectCode;
}

/** What in a project runs as code in the browser of everyone who opens it
 *  (backend `widget_compiler.project_code`). */
export interface ProjectCode {
  /** Widget keys: `<Name>` or `<Group>/<Name>`. */
  customWidgets: string[];
  /** Top-level entries of `external-libraries/` holding a `.js`/`.mjs` file. */
  externalLibraries: string[];
  /** Keys of the project's `external-modules.json` import map. */
  importOverrides: string[];
}

/**
 * - `new`: a certificate never confirmed here; the operator compares it.
 * - `pinned`: the certificate already confirmed for this address or device.
 * - `changed`: a pin names another certificate (or the device dropped to
 *   plain HTTP); pairing is refused.
 * - `none`: the peer answers over plain HTTP.
 */
export type PeerTrust = 'new' | 'pinned' | 'changed' | 'none';

/** What a peer shows before anything is sent to it. */
export interface PeerProbe {
  host: string;
  port: number;
  /** The resolved address the manager actually connects to. */
  address: string;
  scheme: PeerScheme;
  hostname: string | null;
  runtimeId: string | null;
  fingerprint: string | null;
  trust: PeerTrust;
  /** This manager holds a pairing key for the device, bound to this certificate. */
  remembered: boolean;
}

export interface PeerPairing {
  token: string;
  certificateFingerprint?: string;
  runtimeId?: string | null;
  remembered?: boolean;
}

export interface PeerPairOptions {
  /** The SHA-256 the operator confirmed; required over HTTPS. */
  fingerprint?: string | null;
  /** The operator's explicit "isolated network" consent; required over HTTP. */
  allowInsecureHttp?: boolean;
  remember?: boolean;
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
  /** `PEER_PAIRING_REFUSED` when the peer no longer accepts this device's token. */
  code?: string | null;
}

/** The `code` of a peer refusing this device's pairing: revoked, or expired
 *  after 90 days without use (backend `manager_peers_api.PEER_PAIRING_REFUSED`).
 *  On a failed request's error, and on a failed transfer's status. */
export const PEER_PAIRING_REFUSED = 'peer_pairing_refused';

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
  /** Throws `ProjectCodeUnconfirmedError` when the archive carries code and
   *  `trustCustomWidgets` is not set, and `ProjectIdCaseConflictError` when its
   *  id differs from a registered one only in case. `projectId` registers the
   *  archive under that id instead of its own. */
  importProject(
    file: File,
    destinationPath: string,
    trustCustomWidgets?: boolean,
    projectId?: string,
  ): Promise<ProjectEntry>;
  loadPeers(): Promise<PeerListResponse | null>;
  addManualPeer(host: string, port: number, name?: string, scheme?: PeerScheme): Promise<void>;
  removeManualPeer(host: string, port: number): Promise<void>;
  /** Drops the pin for this address, and every pin of the device `runtimeId` names. */
  forgetPeerCertificate(host: string, port: number, runtimeId?: string | null): Promise<void>;
  /** Drops the pairing key this manager kept for the device; its pinned certificate stays. */
  forgetPeerPairing(runtimeId: string): Promise<void>;
  /** Reads the peer's certificate and identity. Sends no password. */
  probePeer(host: string, port: number, scheme: PeerScheme): Promise<PeerProbe>;
  pairPeer(
    host: string,
    port: number,
    password: string,
    scheme?: PeerScheme,
    options?: PeerPairOptions,
  ): Promise<PeerPairing>;
  /** An empty `token` uses the pairing key remembered for `runtimeId`. */
  listPeerProjects(
    host: string,
    port: number,
    token: string,
    scheme?: PeerScheme,
    runtimeId?: string | null,
  ): Promise<PeerProject[]>;
  beginPeerTransfer(args: {
    sourceProjectId: string;
    destinationProjectId: string;
    destinationFolder: string;
    peerHost: string;
    peerPort: number;
    peerScheme: PeerScheme;
    /** Omitted: the pairing key remembered for `peerRuntimeId` is used. */
    token?: string;
    peerRuntimeId?: string | null;
    collisionPolicy: 'reject' | 'replace' | 'copy';
    confirmReplace: boolean;
    keepUsers: boolean;
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
    token?: string;
    peerRuntimeId?: string | null;
    collisionPolicy: 'reject' | 'replace' | 'copy';
    confirmReplace: boolean;
    keepUsers: boolean;
    start: boolean;
    transferId: string;
    /** The operator trusts the source to run the project's code here. */
    trustCustomWidgets?: boolean;
  }): Promise<PeerTransferStatus>;
  getPeerPull(transferId: string): Promise<PeerTransferStatus>;
  cancelPeerPull(transferId: string): Promise<PeerTransferStatus>;
  clearError(): void;
}

/** The import 409's `code` for an archive with code sent without
 *  `trustCustomWidgets` (backend/api/projects_api.py). */
const CUSTOM_WIDGETS_UNCONFIRMED = 'custom_widgets_unconfirmed';

function isProjectCode(value: unknown): value is ProjectCode {
  if (!value || typeof value !== 'object') return false;
  const lists = value as Record<string, unknown>;
  return (['customWidgets', 'externalLibraries', 'importOverrides'] as const).every((kind) => {
    const names = lists[kind];
    return Array.isArray(names) && names.every((name) => typeof name === 'string');
  });
}

/** The import 409's `code` for an archive whose project id differs from a
 *  registered one only in upper and lower case (backend/api/projects_api.py). */
const PROJECT_ID_CASE_CONFLICT = 'project_id_case_conflict';

export class ProjectIdCaseConflictError extends Error {
  /** A free id the server offers to import the archive under instead. */
  readonly suggestedId: string;

  constructor(message: string, suggestedId: string) {
    super(message);
    this.name = 'ProjectIdCaseConflictError';
    this.suggestedId = suggestedId;
  }
}

export class ProjectCodeUnconfirmedError extends Error {
  readonly projectCode: ProjectCode;

  constructor(message: string, projectCode: ProjectCode) {
    super(message);
    this.name = 'ProjectCodeUnconfirmedError';
    this.projectCode = projectCode;
  }
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

  importProject: async (
    file: File,
    destinationPath: string,
    trustCustomWidgets = false,
    projectId?: string,
  ) => {
    const form = new FormData();
    form.append('file', file);
    form.append('destinationPath', destinationPath);
    if (trustCustomWidgets) form.append('trustCustomWidgets', 'true');
    if (projectId) form.append('projectId', projectId);
    const res = await fetch(withBase('/api/projects/import'), { method: 'POST', body: form });
    if (!res.ok) {
      const error = await apiErrorFrom(res.clone());
      if (error.code === PROJECT_ID_CASE_CONFLICT) {
        const body = (await res.json()) as { suggestedId: string };
        throw new ProjectIdCaseConflictError(error.message, body.suggestedId);
      }
      if (error.code !== CUSTOM_WIDGETS_UNCONFIRMED) throw error;
      const body = (await res.json()) as Partial<ProjectCode>;
      throw new ProjectCodeUnconfirmedError(error.message, {
        customWidgets: body.customWidgets ?? [],
        externalLibraries: body.externalLibraries ?? [],
        importOverrides: body.importOverrides ?? [],
      });
    }
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

  forgetPeerCertificate: async (host: string, port: number, runtimeId?: string | null) => {
    const device = runtimeId ? `&runtimeId=${encodeURIComponent(runtimeId)}` : '';
    await managerApiJson(
      `/api/manager/peers/trust?host=${encodeURIComponent(host)}&port=${port}${device}`,
      { method: 'DELETE' },
    );
  },

  forgetPeerPairing: async (runtimeId) => {
    await managerApiJson(`/api/manager/peer-pairings/${encodeURIComponent(runtimeId)}`, {
      method: 'DELETE',
    });
  },

  probePeer: async (host, port, scheme) =>
    managerApiJson<PeerProbe>('/api/manager/peer-probe', {
      method: 'POST',
      body: { host, port, scheme },
    }),

  pairPeer: async (host, port, password, scheme: PeerScheme = 'http', options = {}) =>
    managerApiJson<PeerPairing>('/api/manager/peer-pair', {
      method: 'POST',
      body: { host, port, password, scheme, ...options },
    }),

  listPeerProjects: async (host, port, token, scheme: PeerScheme = 'http', runtimeId = null) => {
    const result = await managerApiJson<{ projects: PeerProject[] }>('/api/manager/peer-projects', {
      method: 'POST',
      body: { host, port, token: token || undefined, scheme, runtimeId: runtimeId ?? undefined },
    });
    // `code` drives a trust prompt: anything but three lists of names reads as
    // "the source does not say", never as "no code".
    return (result.projects ?? []).map((project) =>
      isProjectCode(project.code) ? project : { ...project, code: undefined },
    );
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
