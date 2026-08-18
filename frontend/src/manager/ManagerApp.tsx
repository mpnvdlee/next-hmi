import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useManagerStore, type InstanceSnapshot } from './managerStore';
import { useProjectsStore, describeError, type ProjectEntry } from '@config/store/projectsStore';
import { safeSignInTarget } from '@shared/store/sessionStore';
import { useDocumentTitle } from '@shared/hooks/useDocumentTitle';
import AppTopBarNav from '@shared/components/AppTopBarNav';
import Spinner from '@shared/components/Spinner';
import '@config/styles/config.css';
import '@config/components/shell/ConfigTopBar/style.css';
import '@shared/components/AppTopBarNav/style.css';
import '@config/components/ui/NameInputModal/style.css';
import '@config/components/projects/ProjectsView/style.css';
import '@config/components/projects/ProjectsView/projectForm.css';
import './manager.css';
import Button from '@config/components/ui/Button';
import CreateProjectModal from '@config/components/projects/ProjectsView/CreateProjectModal';
import AddExistingProjectModal from '@config/components/projects/ProjectsView/AddExistingProjectModal';
import ImportProjectModal from '@config/components/projects/ProjectsView/ImportProjectModal';
import RemoveProjectModal from '@config/components/projects/ProjectsView/RemoveProjectModal';
import RenameProjectModal from '@config/components/projects/ProjectsView/RenameProjectModal';
import LocateProjectModal from '@config/components/projects/ProjectsView/LocateProjectModal';
import OperatorSetupModal from '@config/components/projects/ProjectsView/OperatorSetupModal';
import PeerTransferModal from '@config/components/projects/ProjectsView/PeerTransferModal';
import SystemInfoSection from '@config/components/admin/SystemInfoSection';
import RuntimeHomeSection from '@config/components/admin/RuntimeHomeSection';
import LogsSection from '@config/components/admin/LogsSection';
import LogViewerModal from '@config/components/admin/LogViewerModal';
import SecuritySection from '@config/components/admin/SecuritySection';
import HttpsSection from '@config/components/admin/HttpsSection';
import TelemetrySection from '@config/components/admin/TelemetrySection';
import { enterpriseAppGates, enterpriseSettingsPanels } from '@enterprise';

/**
 * Manager dashboard — the always-on front door served at the origin root.
 * Gated by a device-admin password; from here the operator starts/stops and
 * opens project instances (each in its own tab under /runtime/<slug>/ or
 * /editor/<slug>/). It shares the config UI's primitives and project modals so
 * it looks and behaves like the rest of the app.
 */
export default function ManagerApp() {
  const auth = useManagerStore((s) => s.auth);
  const refreshAuth = useManagerStore((s) => s.refreshAuth);
  // A project URL opened without a session is bounced here carrying its own
  // address (see the auth gate in backend/manager.py); once signed in, go back
  // to it instead of dropping the operator on the dashboard.
  const signInTarget = useMemo(
    () => safeSignInTarget(new URLSearchParams(window.location.search).get('signIn')),
    [],
  );

  useEffect(() => {
    refreshAuth();
  }, [refreshAuth]);

  useEffect(() => {
    if (auth === 'authed' && signInTarget) window.location.replace(signInTarget);
  }, [auth, signInTarget]);

  if (auth === 'loading' || (auth === 'authed' && signInTarget)) {
    return (
      <div className="mgr-center">
        <Spinner variant="cfg" />
      </div>
    );
  }
  if (auth === 'needs-setup' || auth === 'needs-login') {
    return <AuthGate mode={auth} />;
  }
  // Gates wrap the dashboard *after* the password gate, so anything one of them
  // shows — the ee build's activation screen, with this device's hardware
  // fingerprint on it — is never reachable by an unauthenticated visitor.
  return (
    <>
      {enterpriseAppGates.reduce<ReactNode>(
        (node, Gate) => (
          <Gate>{node}</Gate>
        ),
        <ManagerRoutes />,
      )}
    </>
  );
}

// ── routes ──────────────────────────────────────────────────────────────────────

function ManagerRoutes() {
  // The root redirect is rendered bare (no top bar / Projects chrome) so hitting
  // the origin root for a default project never flashes the manager dashboard
  // before jumping to the project's runtime.
  return (
    <Routes>
      <Route path="/" element={<RootRedirect />} />
      <Route
        path="/projects"
        element={
          <ManagerShell>
            <ProjectsPage />
          </ManagerShell>
        }
      />
      <Route
        path="/settings"
        element={
          <ManagerShell>
            <SettingsPage />
          </ManagerShell>
        }
      />
      <Route path="*" element={<Navigate to="/projects" replace />} />
    </Routes>
  );
}

// ── manager shell (top bar wrapper for the dashboard pages) ──────────────────────

function ManagerShell({ children }: { children: React.ReactNode }) {
  const logout = useManagerStore((s) => s.logout);
  return (
    <div className="projects-page-shell">
      <header className="cfg-header">
        <div className="cfg-header__left">
          <AppTopBarNav />
        </div>
        <div className="cfg-header__actions">
          <Button variant="ghost" onClick={() => logout()}>
            Sign out
          </Button>
        </div>
      </header>
      {children}
    </div>
  );
}

/**
 * The origin root: jump to the default project's runtime when it's up, else
 * fall through to the Projects page. In production the backend already
 * 302s `/` → `/runtime/<id>/` for a running default before the SPA loads; this
 * covers the dev server (where Vite serves `/`) and the default-stopped case.
 */
function RootRedirect() {
  const defaultProjectId = useProjectsStore((s) => s.defaultProjectId);
  const load = useProjectsStore((s) => s.load);
  const instances = useManagerStore((s) => s.instances);
  const refreshRunning = useManagerStore((s) => s.refreshRunning);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    Promise.all([load(), refreshRunning()]).finally(() => setChecked(true));
  }, [load, refreshRunning]);

  const spinner = (
    <div className="mgr-center">
      <Spinner variant="cfg" />
    </div>
  );

  if (!checked) return spinner;
  if (defaultProjectId && instances[defaultProjectId]?.status === 'running') {
    window.location.assign(`/runtime/${defaultProjectId}/`);
    return spinner;
  }
  return <Navigate to="/projects" replace />;
}

// ── auth gate ──────────────────────────────────────────────────────────────────

function AuthGate({ mode }: { mode: 'needs-setup' | 'needs-login' }) {
  const setup = useManagerStore((s) => s.setup);
  const login = useManagerStore((s) => s.login);
  const authError = useManagerStore((s) => s.authError);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const isSetup = mode === 'needs-setup';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    if (isSetup && password !== confirm) {
      setLocalError('Passwords do not match');
      return;
    }
    setBusy(true);
    try {
      if (isSetup) await setup(password);
      else await login(password);
    } catch (err) {
      setLocalError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mgr-center">
      <form className="name-modal" onSubmit={submit}>
        <h1 className="name-modal__title">NEXT HMI</h1>
        <p className="mgr-auth-card__subtitle">
          {isSetup ? 'Set a device-admin password to secure the manager.' : 'Manager sign-in'}
        </p>
        <div className="cfg-security-form">
          <label className="project-form__field">
            <span className="project-form__label">Password</span>
            <input
              type="password"
              className="cfg-prop-input cfg-prop-input--tall"
              value={password}
              autoFocus
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {isSetup && (
            <label className="project-form__field">
              <span className="project-form__label">Confirm password</span>
              <input
                type="password"
                className="cfg-prop-input cfg-prop-input--tall"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </label>
          )}
          {(localError || authError) && (
            <p className="project-form__status project-form__status--error">
              {localError ?? authError}
            </p>
          )}
        </div>
        <div className="name-modal__actions">
          <Button variant="primary" type="submit" fullWidth disabled={busy || !password}>
            {isSetup ? 'Set password & continue' : 'Sign in'}
          </Button>
        </div>
      </form>
    </div>
  );
}

// ── dashboard ──────────────────────────────────────────────────────────────────

const STATUS_LABELS = {
  starting: 'Starting…',
  running: 'Running',
  stopped: 'Stopped',
  crashed: 'Crashed',
} as const;

/** Keyed by the `reason` the manager's proxy guard sends back. */
const UNAVAILABLE_REASONS: Record<string, string> = {
  unknown: 'no project with that id is registered on this device.',
  missing: 'its project folder is missing. Use Locate to point it at the folder.',
  crashed: 'the instance crashed. Start it again to see the failure.',
  stopped: 'it is not running. Start it first.',
};

function statusLabel(project: ProjectEntry, inst: InstanceSnapshot | undefined): string {
  if (project.status === 'missing') return 'Missing';
  if (!inst) return 'Stopped';
  return STATUS_LABELS[inst.status];
}

type Dialog =
  | { kind: 'none' }
  | { kind: 'create' }
  | { kind: 'add-existing' }
  | { kind: 'import' }
  | { kind: 'remove'; entry: ProjectEntry }
  | { kind: 'rename'; entry: ProjectEntry }
  | { kind: 'locate'; entry: ProjectEntry }
  | { kind: 'transfer'; entry: ProjectEntry }
  | { kind: 'pull' }
  | { kind: 'operator-setup'; entry: ProjectEntry };

function ProjectsPage() {
  useDocumentTitle('Projects');
  const projects = useProjectsStore((s) => s.projects);
  const loadProjects = useProjectsStore((s) => s.load);
  const setDefault = useProjectsStore((s) => s.setDefault);
  const defaultRoot = useProjectsStore((s) => s.defaultProjectsRoot);
  const instances = useManagerStore((s) => s.instances);
  const refreshRunning = useManagerStore((s) => s.refreshRunning);
  const start = useManagerStore((s) => s.start);
  const stop = useManagerStore((s) => s.stop);
  const setProjectMcp = useManagerStore((s) => s.setProjectMcp);
  const exportProject = useProjectsStore((s) => s.exportProject);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' });

  const runningLocalProjectIds = useMemo(
    () =>
      new Set(
        Object.entries(instances)
          .filter(([, inst]) => inst.status === 'running' || inst.status === 'starting')
          .map(([id]) => id),
      ),
    [instances],
  );

  useEffect(() => {
    loadProjects();
    refreshRunning();
    const t = setInterval(() => refreshRunning(), 3000);
    return () => clearInterval(t);
  }, [loadProjects, refreshRunning]);

  // The manager bounces a /runtime|editor/<id>/ navigation back here when the
  // project can't be opened (see manager.py `_unavailable_reason`), so the
  // reason has to be said out loud rather than leaving the operator on a
  // dashboard that silently looks fine.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const blockedId = params.get('unavailable');
    if (!blockedId) return;
    const reason = params.get('reason') ?? 'stopped';
    setRowError(
      `Can't open “${blockedId}” — ${UNAVAILABLE_REASONS[reason] ?? UNAVAILABLE_REASONS.stopped}`,
    );
    params.delete('unavailable');
    params.delete('reason');
    const rest = params.toString();
    window.history.replaceState({}, '', rest ? `/projects?${rest}` : '/projects');
  }, []);

  useEffect(() => {
    const requestedId = new URLSearchParams(window.location.search).get('operatorSetup');
    if (!requestedId) return;
    const entry = projects.find(
      (project) => project.id === requestedId && project.operatorSetupRequired,
    );
    if (!entry) return;
    setDialog({ kind: 'operator-setup', entry });
    window.history.replaceState({}, '', '/projects');
  }, [projects]);

  const act = useCallback(async (id: string, fn: (id: string) => Promise<void>) => {
    setBusyId(id);
    setRowError(null);
    try {
      await fn(id);
    } catch (err) {
      setRowError(describeError(err));
    } finally {
      setBusyId(null);
    }
  }, []);

  // Selecting the default also starts it (when stopped) so the origin root has
  // a running runtime to serve.
  const makeDefault = useCallback(
    (p: ProjectEntry) =>
      act(p.id, async (id) => {
        await setDefault(id);
        if (instances[id]?.status !== 'running') await start(id);
      }),
    [act, setDefault, start, instances],
  );

  const closeDialog = () => setDialog({ kind: 'none' });

  return (
    <>
      <div className="projects-page">
        <div className="projects-page__inner">
          <header className="projects-page__header">
            <div className="projects-page__actions">
              <Button variant="default" onClick={() => setDialog({ kind: 'import' })}>
                ↑ Import zip
              </Button>
              <Button variant="default" onClick={() => setDialog({ kind: 'add-existing' })}>
                ⊕ Add existing
              </Button>
              <Button variant="default" onClick={() => setDialog({ kind: 'pull' })}>
                ⇩ Pull from peer
              </Button>
              <Button variant="primary" onClick={() => setDialog({ kind: 'create' })}>
                + New project
              </Button>
            </div>
          </header>

          {rowError && (
            <div className="projects-page__error">
              <span>{rowError}</span>{' '}
              <Button variant="ghost" size="sm" onClick={() => setRowError(null)}>
                Dismiss
              </Button>
            </div>
          )}

          {projects.length === 0 ? (
            <div className="projects-page__empty">
              No projects yet. Click <strong>+ New project</strong> to get started.
            </div>
          ) : (
            <ul className="projects-page__list">
              {projects.map((p) => {
                const inst = instances[p.id];
                const running = inst?.status === 'running';
                const transient = inst?.status === 'starting';
                const stoppable = !!inst && inst.status !== 'stopped';
                return (
                  <li
                    key={p.id}
                    className={[
                      'project-row',
                      running && 'project-row--live',
                      p.status === 'missing' && 'project-row--missing',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <div className="project-row__body">
                      <div className="project-row__title-line">
                        <span className="project-row__name">{p.name}</span>
                        <code
                          className="project-row__id"
                          title="Project id — addresses this project in its URLs and in MCP token scopes"
                        >
                          {p.id}
                        </code>
                        <span className={`mgr-status mgr-status--${inst?.status ?? 'stopped'}`}>
                          {statusLabel(p, inst)}
                        </span>
                      </div>
                      <code className="project-row__path">{p.path}</code>
                      {inst?.lastError && (
                        <span className="mgr-status__error">{inst.lastError}</span>
                      )}
                      <div className="project-row__toggles">
                        <label
                          className="mgr-default-toggle"
                          title="Show this project at the origin root (localhost) and keep it running"
                        >
                          <input
                            type="radio"
                            name="default-project"
                            checked={p.isDefault}
                            disabled={
                              busyId === p.id ||
                              p.status === 'missing' ||
                              p.operatorSetupStatus !== 'complete'
                            }
                            onChange={() => makeDefault(p)}
                          />
                          <span>{p.isDefault ? 'Default project' : 'Set as default'}</span>
                        </label>
                        <label
                          className="mgr-mcp-toggle"
                          title="Allow the workspace MCP endpoint to write to this project"
                        >
                          <input
                            type="checkbox"
                            checked={p.mcpEnabled}
                            disabled={busyId === p.id || p.status === 'missing'}
                            onChange={(e) => act(p.id, () => setProjectMcp(p.id, e.target.checked))}
                          />
                          <span>MCP {p.mcpEnabled ? 'enabled' : 'disabled'}</span>
                        </label>
                      </div>
                    </div>
                    <div className="project-row__actions">
                      {p.operatorSetupStatus === 'error' ? (
                        <Button
                          variant="default"
                          size="sm"
                          disabled
                          title={p.operatorSetupError ?? 'Project credentials are unavailable'}
                        >
                          Credentials unavailable
                        </Button>
                      ) : p.operatorSetupRequired ? (
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={busyId === p.id || p.status === 'missing'}
                          onClick={() => setDialog({ kind: 'operator-setup', entry: p })}
                        >
                          Set operator password
                        </Button>
                      ) : running ? (
                        <>
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={() => window.open(`/runtime/${p.id}/`, '_blank', 'noopener')}
                          >
                            Open
                          </Button>
                          <Button
                            variant="default"
                            size="sm"
                            onClick={() => window.open(`/editor/${p.id}/`, '_blank', 'noopener')}
                          >
                            Open editor
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="default"
                          size="sm"
                          disabled={busyId === p.id || transient || p.status === 'missing'}
                          onClick={() => act(p.id, start)}
                        >
                          {busyId === p.id ? '…' : 'Start'}
                        </Button>
                      )}
                      {p.status === 'missing' && (
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={busyId === p.id}
                          onClick={() => setDialog({ kind: 'locate', entry: p })}
                        >
                          Locate…
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyId === p.id || stoppable}
                        title={
                          stoppable
                            ? 'Stop the project before renaming it'
                            : 'Change the project name or id'
                        }
                        onClick={() => setDialog({ kind: 'rename', entry: p })}
                      >
                        Rename
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyId === p.id || p.status === 'missing'}
                        title="Download this project as a zip"
                        onClick={() => exportProject(p.id)}
                      >
                        Export
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyId === p.id || p.status === 'missing'}
                        onClick={() => setDialog({ kind: 'transfer', entry: p })}
                      >
                        Transfer
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyId === p.id || !stoppable}
                        onClick={() => act(p.id, stop)}
                      >
                        Stop
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyId === p.id || stoppable}
                        title={stoppable ? 'Stop the project before removing it' : undefined}
                        onClick={() => setDialog({ kind: 'remove', entry: p })}
                      >
                        Remove
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {dialog.kind === 'create' && (
        <CreateProjectModal
          defaultRoot={defaultRoot}
          onCancel={closeDialog}
          onCreated={(entry) => setDialog({ kind: 'operator-setup', entry })}
        />
      )}
      {dialog.kind === 'add-existing' && (
        <AddExistingProjectModal
          defaultRoot={defaultRoot}
          onCancel={closeDialog}
          onAdded={closeDialog}
        />
      )}
      {dialog.kind === 'import' && (
        <ImportProjectModal
          defaultRoot={defaultRoot}
          onCancel={closeDialog}
          onImported={closeDialog}
        />
      )}
      {dialog.kind === 'rename' && (
        <RenameProjectModal entry={dialog.entry} onCancel={closeDialog} onRenamed={closeDialog} />
      )}
      {dialog.kind === 'remove' && (
        <RemoveProjectModal entry={dialog.entry} onCancel={closeDialog} onRemoved={closeDialog} />
      )}
      {dialog.kind === 'locate' && (
        <LocateProjectModal
          entry={dialog.entry}
          defaultRoot={defaultRoot}
          onCancel={closeDialog}
          onLocated={closeDialog}
        />
      )}
      {dialog.kind === 'operator-setup' && (
        <OperatorSetupModal entry={dialog.entry} onCompleted={closeDialog} />
      )}
      {dialog.kind === 'transfer' && (
        <PeerTransferModal
          direction="push"
          source={dialog.entry}
          onClose={closeDialog}
          onTransferred={() => {
            void loadProjects();
          }}
        />
      )}
      {dialog.kind === 'pull' && (
        <PeerTransferModal
          direction="pull"
          runningLocalProjectIds={runningLocalProjectIds}
          onClose={closeDialog}
          onTransferred={() => {
            void loadProjects();
          }}
        />
      )}
    </>
  );
}

// ── settings ────────────────────────────────────────────────────────────────────

function SettingsPage() {
  useDocumentTitle('Settings');
  const systemInfo = useManagerStore((s) => s.systemInfo);
  const loadSystemInfo = useManagerStore((s) => s.loadSystemInfo);
  const runtimeHome = useProjectsStore((s) => s.runtimeHome);
  const loadRuntimeHome = useProjectsStore((s) => s.loadRuntimeHome);
  const changePassword = useManagerStore((s) => s.changePassword);
  const tls = useManagerStore((s) => s.tls);
  const loadTls = useManagerStore((s) => s.loadTls);
  const applyTls = useManagerStore((s) => s.applyTls);
  const regenerateTlsCertificate = useManagerStore((s) => s.regenerateTlsCertificate);
  const uploadTlsCertificate = useManagerStore((s) => s.uploadTlsCertificate);
  const restartForTls = useManagerStore((s) => s.restartForTls);
  const telemetry = useManagerStore((s) => s.telemetry);
  const loadTelemetry = useManagerStore((s) => s.loadTelemetry);
  const applyTelemetry = useManagerStore((s) => s.applyTelemetry);
  const [logsOpen, setLogsOpen] = useState(false);

  useEffect(() => {
    void loadSystemInfo();
    void loadRuntimeHome();
    const infoId = setInterval(loadSystemInfo, 5000);
    return () => clearInterval(infoId);
  }, [loadSystemInfo, loadRuntimeHome]);

  return (
    <div className="projects-page">
      <div className="projects-page__inner">
        <SystemInfoSection info={systemInfo} />
        <RuntimeHomeSection status={runtimeHome ? { path: runtimeHome } : null} />
        <LogsSection onOpen={() => setLogsOpen(true)} />
        <SecuritySection onChangePassword={changePassword} />
        <HttpsSection
          status={tls}
          onLoad={loadTls}
          onApply={applyTls}
          onRegenerate={regenerateTlsCertificate}
          onUploadCustom={uploadTlsCertificate}
          onRestart={restartForTls}
        />
        <TelemetrySection status={telemetry} onLoad={loadTelemetry} onApply={applyTelemetry} />
        {enterpriseSettingsPanels.map((Panel, i) => (
          <Panel key={i} />
        ))}
      </div>
      {logsOpen && <LogViewerModal onClose={() => setLogsOpen(false)} />}
    </div>
  );
}
