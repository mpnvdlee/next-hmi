import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import ManagerApp from './ManagerApp';
import { useManagerStore, type InstanceSnapshot } from './managerStore';
import { useProjectsStore, type ProjectEntry } from '@config/store/projectsStore';
import { enterpriseAppGates } from '@enterprise';

function project(overrides: Partial<ProjectEntry> = {}): ProjectEntry {
  return {
    id: 'p1',
    name: 'Line 1',
    path: '/projects/line-1',
    addedAt: '2026-01-01T00:00:00Z',
    lastOpenedAt: null,
    status: 'present',
    inProjectsRoot: true,
    isDefault: false,
    mcpEnabled: false,
    credentialsStatus: 'ok',
    credentialsError: null,
    formatVersion: null,
    minAppVersion: null,
    needsUpgrade: false,
    unsupportedFormat: false,
    lastMigration: null,
    thumbnailUpdatedAt: null,
    ...overrides,
  };
}

function instance(overrides: Partial<InstanceSnapshot> = {}): InstanceSnapshot {
  return {
    id: 'p1',
    name: 'Line 1',
    path: '/projects/line-1',
    basePath: '/runtime/p1/',
    port: 9101,
    pid: 4242,
    status: 'running',
    startedAt: 1,
    restarts: 0,
    lastError: null,
    ...overrides,
  };
}

const MANAGER_INITIAL = useManagerStore.getState();
const PROJECTS_INITIAL = useProjectsStore.getState();

/** Replaces every async manager action with a resolved no-op so a render never
 *  reaches the network; individual tests override the ones they assert on. */
function stubManagerActions(overrides: Partial<ReturnType<typeof useManagerStore.getState>> = {}) {
  useManagerStore.setState({
    refreshAuth: vi.fn().mockResolvedValue(undefined),
    setup: vi.fn().mockResolvedValue(undefined),
    login: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    changePassword: vi.fn().mockResolvedValue(undefined),
    refreshRunning: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    setProjectMcp: vi.fn().mockResolvedValue(undefined),
    loadSystemInfo: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });
}

function stubProjectsActions(
  overrides: Partial<ReturnType<typeof useProjectsStore.getState>> = {},
) {
  useProjectsStore.setState({
    load: vi.fn().mockResolvedValue(undefined),
    setDefault: vi.fn().mockResolvedValue(undefined),
    loadRuntimeHome: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ManagerApp />
    </MemoryRouter>,
  );
}

/** Row `<li>` for a project, addressed by its visible name. */
function row(name: string): HTMLElement {
  return screen.getByText(name).closest('li') as HTMLElement;
}

/** The open modal dialog. ModalShell renders a plain overlay/dialog pair with no
 *  ARIA role, so tests address it by its container class. */
function modal(): HTMLElement | null {
  return document.querySelector('.cfg-modal');
}

async function openModal(): Promise<HTMLElement> {
  await waitFor(() => expect(modal()).not.toBeNull());
  return modal() as HTMLElement;
}

beforeEach(() => {
  useManagerStore.setState({
    auth: 'authed',
    authError: null,
    instances: {},
    systemInfo: null,
  });
  useProjectsStore.setState({
    projects: [],
    defaultProjectId: null,
    defaultProjectsRoot: '/projects',
    runtimeHome: null,
    loading: false,
    error: null,
    busyProjectId: null,
  });
  stubManagerActions();
  stubProjectsActions();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useManagerStore.setState(MANAGER_INITIAL);
  useProjectsStore.setState(PROJECTS_INITIAL);
});

describe('startup gate', () => {
  it('refreshes auth on mount and shows a spinner until the status lands', () => {
    const refreshAuth = vi.fn().mockResolvedValue(undefined);
    useManagerStore.setState({ auth: 'loading', refreshAuth });

    const { container } = renderAt('/projects');

    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.mgr-center')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });

  it('shows the sign-in form, not the dashboard, when a password is set', () => {
    useManagerStore.setState({ auth: 'needs-login' });

    renderAt('/projects');

    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Confirm password')).toBeNull();
    expect(screen.queryByRole('button', { name: '+ New project' })).toBeNull();
  });

  it('shows the first-run setup form when no password exists yet', () => {
    useManagerStore.setState({ auth: 'needs-setup' });

    renderAt('/projects');

    expect(screen.getByRole('button', { name: 'Set password & continue' })).toBeInTheDocument();
    expect(screen.getByText('Confirm password')).toBeInTheDocument();
  });

  describe('enterprise app gates', () => {
    // The array is empty in this (oss) build, so a gate is pushed in to drive
    // the seam. The `ee` build contributes its activation screen the same way.
    afterEach(() => {
      enterpriseAppGates.length = 0;
    });

    it('renders the dashboard directly when no gate is registered', () => {
      useManagerStore.setState({ auth: 'authed' });
      useProjectsStore.setState({ projects: [project()] });

      renderAt('/projects');

      expect(screen.getByRole('button', { name: '+ New project' })).toBeInTheDocument();
    });

    it('lets a gate stand in for the whole dashboard', () => {
      enterpriseAppGates.push(() => <p>Activate this installation</p>);
      useManagerStore.setState({ auth: 'authed' });
      useProjectsStore.setState({ projects: [project()] });

      renderAt('/projects');

      expect(screen.getByText('Activate this installation')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '+ New project' })).toBeNull();
    });

    it('renders the dashboard inside a gate that passes its children through', () => {
      enterpriseAppGates.push(({ children }) => <div data-testid="gate">{children}</div>);
      useManagerStore.setState({ auth: 'authed' });
      useProjectsStore.setState({ projects: [project()] });

      renderAt('/projects');

      expect(
        within(screen.getByTestId('gate')).getByRole('button', { name: '+ New project' }),
      ).toBeInTheDocument();
    });

    it('applies a gate only after the password gate, never in front of it', () => {
      // The ee gate's screen carries this device's hardware fingerprint, so it
      // must never render for a visitor who has not signed in.
      enterpriseAppGates.push(() => <p>Activate this installation</p>);
      useManagerStore.setState({ auth: 'needs-login' });

      renderAt('/projects');

      expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
      expect(screen.queryByText('Activate this installation')).toBeNull();
    });
  });
});

describe('auth gate form', () => {
  it('submits the password to login and leaves setup alone', async () => {
    const login = vi.fn().mockResolvedValue(undefined);
    const setup = vi.fn().mockResolvedValue(undefined);
    useManagerStore.setState({ auth: 'needs-login', login, setup });
    renderAt('/projects');

    await userEvent.type(screen.getByLabelText(/Password/i), 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(login).toHaveBeenCalledWith('hunter2');
    expect(setup).not.toHaveBeenCalled();
  });

  it('keeps the submit button disabled until a password is typed', async () => {
    useManagerStore.setState({ auth: 'needs-login' });
    renderAt('/projects');

    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Password/i), 'x');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('rejects a setup whose confirmation does not match, without calling setup', async () => {
    const setup = vi.fn().mockResolvedValue(undefined);
    useManagerStore.setState({ auth: 'needs-setup', setup });
    const { container } = renderAt('/projects');
    const inputs = container.querySelectorAll('input[type="password"]');

    await userEvent.type(inputs[0], 'hunter2');
    await userEvent.type(inputs[1], 'hunter3');
    await userEvent.click(screen.getByRole('button', { name: 'Set password & continue' }));

    expect(await screen.findByText('Passwords do not match')).toBeInTheDocument();
    expect(setup).not.toHaveBeenCalled();
  });

  it('sets the device-admin password once both fields agree', async () => {
    const setup = vi.fn().mockResolvedValue(undefined);
    useManagerStore.setState({ auth: 'needs-setup', setup });
    const { container } = renderAt('/projects');
    const inputs = container.querySelectorAll('input[type="password"]');

    await userEvent.type(inputs[0], 'hunter2');
    await userEvent.type(inputs[1], 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: 'Set password & continue' }));

    await waitFor(() => expect(setup).toHaveBeenCalledWith('hunter2'));
  });

  it('surfaces a rejected sign-in as an inline error', async () => {
    const login = vi.fn().mockRejectedValue(new Error('Invalid password'));
    useManagerStore.setState({ auth: 'needs-login', login });
    renderAt('/projects');

    await userEvent.type(screen.getByLabelText(/Password/i), 'nope');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Invalid password')).toBeInTheDocument();
  });
});

describe('projects dashboard', () => {
  it('loads projects and the running set on mount, then polls the supervisor', () => {
    vi.useFakeTimers();
    const load = vi.fn().mockResolvedValue(undefined);
    const refreshRunning = vi.fn().mockResolvedValue(undefined);
    stubProjectsActions({ load });
    stubManagerActions({ refreshRunning });

    const view = renderAt('/projects');
    expect(load).toHaveBeenCalledTimes(1);
    expect(refreshRunning).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(6000);
    expect(refreshRunning).toHaveBeenCalledTimes(3);

    view.unmount();
    vi.advanceTimersByTime(6000);
    expect(refreshRunning).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('invites the operator to create a project when the manifest is empty', () => {
    renderAt('/projects');

    expect(screen.getByText(/No projects yet/)).toBeInTheDocument();
  });

  it('labels a project with no supervisor entry as stopped and offers Start', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    stubManagerActions({ start });
    useProjectsStore.setState({ projects: [project()] });
    renderAt('/projects');

    expect(within(row('Line 1')).getByText('Stopped')).toBeInTheDocument();
    await userEvent.click(within(row('Line 1')).getByRole('button', { name: 'Start' }));

    expect(start).toHaveBeenCalledWith('p1');
  });

  it('swaps Start for Open/Open editor once the instance is running', () => {
    useProjectsStore.setState({ projects: [project()] });
    useManagerStore.setState({ instances: { p1: instance() } });
    renderAt('/projects');

    const projectRow = within(row('Line 1'));
    expect(projectRow.getByText('Running')).toBeInTheDocument();
    expect(projectRow.getByRole('button', { name: 'Open' })).toBeInTheDocument();
    expect(projectRow.getByRole('button', { name: 'Open editor' })).toBeInTheDocument();
    expect(projectRow.queryByRole('button', { name: 'Start' })).toBeNull();
  });

  it('opens the runtime and the editor in separate tabs', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    useProjectsStore.setState({ projects: [project()] });
    useManagerStore.setState({ instances: { p1: instance() } });
    renderAt('/projects');

    await userEvent.click(within(row('Line 1')).getByRole('button', { name: 'Open' }));
    await userEvent.click(within(row('Line 1')).getByRole('button', { name: 'Open editor' }));

    expect(open).toHaveBeenNthCalledWith(1, '/runtime/p1/', '_blank', 'noopener');
    expect(open).toHaveBeenNthCalledWith(2, '/editor/p1/', '_blank', 'noopener');
  });

  it('stops a running instance and blocks Remove until it is stopped', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    stubManagerActions({ stop });
    useProjectsStore.setState({ projects: [project()] });
    useManagerStore.setState({ instances: { p1: instance() } });
    renderAt('/projects');

    const remove = within(row('Line 1')).getByRole('button', { name: 'Remove' });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAttribute('title', 'Stop the project before removing it');

    await userEvent.click(within(row('Line 1')).getByRole('button', { name: 'Stop' }));
    expect(stop).toHaveBeenCalledWith('p1');
  });

  it('disables Stop when there is no supervisor entry to stop', () => {
    useProjectsStore.setState({ projects: [project()] });
    renderAt('/projects');

    expect(within(row('Line 1')).getByRole('button', { name: 'Stop' })).toBeDisabled();
  });

  it('shows a crashed instance with its last error and still allows a restart', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    stubManagerActions({ start });
    useProjectsStore.setState({ projects: [project()] });
    useManagerStore.setState({
      instances: { p1: instance({ status: 'crashed', lastError: 'exited with code 1' }) },
    });
    renderAt('/projects');

    const projectRow = within(row('Line 1'));
    expect(projectRow.getByText('Crashed')).toBeInTheDocument();
    expect(projectRow.getByText('exited with code 1')).toBeInTheDocument();

    await userEvent.click(projectRow.getByRole('button', { name: 'Start' }));
    expect(start).toHaveBeenCalledWith('p1');
  });

  it('locks a starting instance out of a second Start click', () => {
    useProjectsStore.setState({ projects: [project()] });
    useManagerStore.setState({ instances: { p1: instance({ status: 'starting' }) } });
    renderAt('/projects');

    const projectRow = within(row('Line 1'));
    expect(projectRow.getByText('Starting…')).toBeInTheDocument();
    expect(projectRow.getByRole('button', { name: 'Start' })).toBeDisabled();
    expect(projectRow.getByRole('button', { name: 'Stop' })).toBeEnabled();
  });

  it('marks a project whose folder vanished as missing and disables every action but Locate', () => {
    useProjectsStore.setState({ projects: [project({ status: 'missing' })] });
    renderAt('/projects');

    const projectRow = within(row('Line 1'));
    expect(projectRow.getByText('Missing')).toBeInTheDocument();
    expect(projectRow.getByRole('button', { name: 'Start' })).toBeDisabled();
    expect(projectRow.getByRole('button', { name: 'Transfer' })).toBeDisabled();
    expect(projectRow.getByRole('button', { name: 'Export' })).toBeDisabled();
    expect(projectRow.getByRole('radio')).toBeDisabled();
    expect(projectRow.getByRole('checkbox')).toBeDisabled();
    // The one repair the operator can still reach — everything else needs the
    // folder that is gone.
    expect(projectRow.getByRole('button', { name: 'Locate…' })).toBeEnabled();
  });

  it('offers Locate only for a missing project', () => {
    useProjectsStore.setState({ projects: [project()] });
    renderAt('/projects');

    expect(within(row('Line 1')).queryByRole('button', { name: 'Locate…' })).toBeNull();
  });

  it('downloads the project zip from the row', async () => {
    const exportProject = vi.fn();
    useProjectsStore.setState({ projects: [project()], exportProject });
    renderAt('/projects');

    await userEvent.click(within(row('Line 1')).getByRole('button', { name: 'Export' }));

    expect(exportProject).toHaveBeenCalledWith('p1');
  });

  it('shows the project id next to its name', () => {
    useProjectsStore.setState({ projects: [project()] });
    renderAt('/projects');

    expect(within(row('Line 1')).getByText('[p1]')).toBeInTheDocument();
  });

  it('blocks Rename until the project is stopped', () => {
    useProjectsStore.setState({ projects: [project()] });
    useManagerStore.setState({ instances: { p1: instance() } });
    renderAt('/projects');

    const rename = within(row('Line 1')).getByRole('button', { name: 'Rename' });
    expect(rename).toBeDisabled();
    expect(rename).toHaveAttribute('title', 'Stop the project before renaming it');
  });

  it('still offers Rename for a missing project — the name is manifest-side', () => {
    useProjectsStore.setState({ projects: [project({ status: 'missing' })] });
    renderAt('/projects');

    expect(within(row('Line 1')).getByRole('button', { name: 'Rename' })).toBeEnabled();
  });

  it('sends only the changed fields from the rename dialog', async () => {
    const renameProject = vi.fn().mockResolvedValue(project());
    useProjectsStore.setState({ projects: [project()], renameProject });
    renderAt('/projects');

    await userEvent.click(within(row('Line 1')).getByRole('button', { name: 'Rename' }));
    const dialog = within(await openModal());
    await userEvent.clear(dialog.getByDisplayValue('Line 1'));
    await userEvent.type(dialog.getByPlaceholderText('Plant A'), 'Line 2');
    await userEvent.click(dialog.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(renameProject).toHaveBeenCalledWith('p1', { name: 'Line 2' }));
    await waitFor(() => expect(modal()).toBeNull());
  });

  it('renames the id from the dialog and previews the new URLs', async () => {
    const renameProject = vi.fn().mockResolvedValue(project());
    useProjectsStore.setState({ projects: [project()], renameProject });
    renderAt('/projects');

    await userEvent.click(within(row('Line 1')).getByRole('button', { name: 'Rename' }));
    const dialog = within(await openModal());
    await userEvent.clear(dialog.getByPlaceholderText('plant-a'));
    await userEvent.type(dialog.getByPlaceholderText('plant-a'), 'line-2');

    expect(dialog.getByText('/runtime/line-2/')).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: 'Save' }));

    expect(renameProject).toHaveBeenCalledWith('p1', { id: 'line-2' });
  });

  it('refuses to submit an id the backend grammar would reject', async () => {
    const renameProject = vi.fn().mockResolvedValue(project());
    useProjectsStore.setState({ projects: [project()], renameProject });
    renderAt('/projects');

    await userEvent.click(within(row('Line 1')).getByRole('button', { name: 'Rename' }));
    const dialog = within(await openModal());
    await userEvent.clear(dialog.getByPlaceholderText('plant-a'));
    await userEvent.type(dialog.getByPlaceholderText('plant-a'), '../escape');

    expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(renameProject).not.toHaveBeenCalled();
  });

  it('reports a failed supervisor action in a dismissible banner', async () => {
    stubManagerActions({ start: vi.fn().mockRejectedValue(new Error('port 9101 in use')) });
    useProjectsStore.setState({ projects: [project()] });
    renderAt('/projects');

    await userEvent.click(within(row('Line 1')).getByRole('button', { name: 'Start' }));

    expect(await screen.findByText('port 9101 in use')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('port 9101 in use')).toBeNull();
  });

  it('promoting a stopped project to default also starts it', async () => {
    const setDefault = vi.fn().mockResolvedValue(undefined);
    const start = vi.fn().mockResolvedValue(undefined);
    stubProjectsActions({ setDefault });
    stubManagerActions({ start });
    useProjectsStore.setState({ projects: [project()] });
    renderAt('/projects');

    await userEvent.click(within(row('Line 1')).getByRole('radio'));

    await waitFor(() => expect(setDefault).toHaveBeenCalledWith('p1'));
    expect(start).toHaveBeenCalledWith('p1');
  });

  it('promoting an already-running project to default does not restart it', async () => {
    const setDefault = vi.fn().mockResolvedValue(undefined);
    const start = vi.fn().mockResolvedValue(undefined);
    stubProjectsActions({ setDefault });
    stubManagerActions({ start });
    useProjectsStore.setState({ projects: [project()] });
    useManagerStore.setState({ instances: { p1: instance() } });
    renderAt('/projects');

    await userEvent.click(within(row('Line 1')).getByRole('radio'));

    await waitFor(() => expect(setDefault).toHaveBeenCalledWith('p1'));
    expect(start).not.toHaveBeenCalled();
  });

  it('toggles the MCP write permission for the row', async () => {
    const setProjectMcp = vi.fn().mockResolvedValue(undefined);
    stubManagerActions({ setProjectMcp });
    useProjectsStore.setState({ projects: [project()] });
    renderAt('/projects');

    expect(within(row('Line 1')).getByText('MCP disabled')).toBeInTheDocument();
    await userEvent.click(within(row('Line 1')).getByRole('checkbox'));

    expect(setProjectMcp).toHaveBeenCalledWith('p1', true);
  });
});

describe('unavailable bounce', () => {
  /** The manager 303s a `/runtime|editor/<id>/` navigation it cannot serve to
   *  `/projects?unavailable=…`; the dashboard reads that off the real location,
   *  not the router's, so the tests drive window.history directly. */
  function landOn(search: string) {
    window.history.replaceState({}, '', `/projects${search}`);
    useProjectsStore.setState({ projects: [project()] });
    renderAt('/projects');
  }

  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('says why a project could not be opened and clears the query', async () => {
    landOn('?unavailable=p1&reason=stopped');

    expect(
      await screen.findByText(/Can't open .p1. — it is not running\. Start it first\./),
    ).toBeInTheDocument();
    expect(window.location.search).toBe('');
  });

  it.each([
    ['unknown', /no project with that id is registered on this device\./],
    ['missing', /its project folder is missing\./],
    ['crashed', /the instance crashed\./],
  ])('reports the %s reason the manager sent', async (reason, message) => {
    landOn(`?unavailable=p1&reason=${reason}`);

    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it('falls back to the stopped wording for a reason it does not know', async () => {
    landOn('?unavailable=p1&reason=something-new');

    expect(await screen.findByText(/it is not running\. Start it first\./)).toBeInTheDocument();
  });

  it('says nothing on a plain visit to the dashboard', () => {
    landOn('');

    expect(screen.queryByText(/Can't open/)).toBeNull();
  });

  it('dismisses the message', async () => {
    landOn('?unavailable=p1&reason=stopped');
    await screen.findByText(/Can't open/);

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByText(/Can't open/)).toBeNull();
  });
});

describe('project version / upgrade gate', () => {
  it('opens an upgrade dialog instead of starting a project that needs one', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    stubManagerActions({ start });
    useProjectsStore.setState({
      projects: [project({ needsUpgrade: true })],
    });
    renderAt('/projects');

    await userEvent.click(within(row('Line 1')).getByRole('button', { name: 'Start' }));

    const dialog = within(await openModal());
    expect(dialog.getByText(/needs to upgrade this project's file format/)).toBeInTheDocument();
    expect(start).not.toHaveBeenCalled();
  });

  it('confirms the upgrade, starts the project, and refreshes the list', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const load = vi.fn().mockResolvedValue(undefined);
    stubManagerActions({ start });
    stubProjectsActions({ load });
    useProjectsStore.setState({ projects: [project({ needsUpgrade: true })] });
    renderAt('/projects');

    await userEvent.click(within(row('Line 1')).getByRole('button', { name: 'Start' }));
    const dialog = within(await openModal());
    await userEvent.click(dialog.getByRole('button', { name: 'Upgrade & start' }));

    await waitFor(() => expect(start).toHaveBeenCalledWith('p1', { confirmUpgrade: true }));
    await waitFor(() => expect(load).toHaveBeenCalled());
    await waitFor(() => expect(modal()).toBeNull());
  });

  it('cancels out of the upgrade dialog without starting the project', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    stubManagerActions({ start });
    useProjectsStore.setState({ projects: [project({ needsUpgrade: true })] });
    renderAt('/projects');

    await userEvent.click(within(row('Line 1')).getByRole('button', { name: 'Start' }));
    await userEvent.click(within(await openModal()).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(modal()).toBeNull());
    expect(start).not.toHaveBeenCalled();
  });

  it('blocks starting a project newer than this build supports, naming the version needed', () => {
    useProjectsStore.setState({
      projects: [project({ unsupportedFormat: true, minAppVersion: '9.9.9' })],
    });
    renderAt('/projects');

    expect(within(row('Line 1')).getByRole('button', { name: 'Requires update' })).toBeDisabled();
    expect(within(row('Line 1')).getByText(/Needs NEXT HMI 9\.9\.9 or newer/)).toBeInTheDocument();
  });

  it('falls back to a generic note when the project carries no release stamp', () => {
    useProjectsStore.setState({
      projects: [project({ unsupportedFormat: true, minAppVersion: null })],
    });
    renderAt('/projects');

    expect(
      within(row('Line 1')).getByText(/Needs a newer version of NEXT HMI/),
    ).toBeInTheDocument();
  });

  it('leaves the row clean when the format is supported', () => {
    useProjectsStore.setState({ projects: [project({ minAppVersion: '9.9.9' })] });
    renderAt('/projects');

    expect(within(row('Line 1')).queryByText(/Needs NEXT HMI/)).toBeNull();
  });

  it('never shows a permanent per-row upgrade note, even for a project with migration history', () => {
    useProjectsStore.setState({
      projects: [
        project({
          lastMigration: {
            fromVersion: 5,
            toVersion: 6,
            at: '2026-05-24T10:00:00Z',
            backup: '/projects/line-1/.backups/pre-migration-20260524T100000Z-app-1.2.3.zip',
          },
        }),
      ],
    });
    renderAt('/projects');

    expect(screen.queryByText(/Upgraded from v5 to v6/)).toBeNull();
  });

  it('announces what changed once, right after an upgrade completes, dismissibly', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    // ProjectsPage reloads on mount too — only the reload the upgrade modal
    // triggers (the second one) should reflect the migrated project.
    let loadCalls = 0;
    const load = vi.fn().mockImplementation(async () => {
      loadCalls += 1;
      if (loadCalls < 2) return;
      useProjectsStore.setState({
        projects: [
          project({
            needsUpgrade: false,
            lastMigration: {
              fromVersion: 4,
              toVersion: 7,
              at: '2026-05-24T10:00:00Z',
              backup: '/projects/line-1/.backups/pre-migration-20260524T100000Z-app-1.2.3.zip',
            },
          }),
        ],
      });
    });
    stubManagerActions({ start });
    stubProjectsActions({ load });
    useProjectsStore.setState({ projects: [project({ needsUpgrade: true })] });
    renderAt('/projects');

    await userEvent.click(within(row('Line 1')).getByRole('button', { name: 'Start' }));
    await userEvent.click(
      within(await openModal()).getByRole('button', { name: 'Upgrade & start' }),
    );

    const notice = await screen.findByText(/Upgraded "Line 1" from v4 to v7/);
    expect(notice).toHaveTextContent('/projects/line-1/.backups/pre-migration-20260524T100000Z-app-1.2.3.zip');
    // Not a per-row detail — it's the page-level notice.
    expect(row('Line 1')).not.toContainElement(notice);

    await userEvent.click(
      within(notice.closest('.projects-page__notice')!).getByRole('button', {
        name: 'Dismiss',
      }),
    );
    expect(screen.queryByText(/Upgraded "Line 1" from v4 to v7/)).toBeNull();
  });
});

describe('operator credential state', () => {
  it('offers the run controls on a project that has no operator account yet', () => {
    useProjectsStore.setState({ projects: [project()] });
    renderAt('/projects');

    const projectRow = within(row('Line 1'));
    expect(projectRow.getByRole('button', { name: 'Start' })).toBeInTheDocument();
    expect(projectRow.queryByRole('button', { name: 'Set operator password' })).toBeNull();
    expect(projectRow.getByRole('radio')).toBeEnabled();
  });

  it('reports an unreadable credential as a disabled row action carrying the reason', () => {
    useProjectsStore.setState({
      projects: [
        project({
          credentialsStatus: 'error',
          credentialsError: 'users.json is corrupt',
        }),
      ],
    });
    renderAt('/projects');

    const button = within(row('Line 1')).getByRole('button', { name: 'Credentials unavailable' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'users.json is corrupt');
  });
});

describe('project dialogs', () => {
  it('opens the remove confirmation for a stopped project', async () => {
    useProjectsStore.setState({ projects: [project()] });
    renderAt('/projects');

    await userEvent.click(within(row('Line 1')).getByRole('button', { name: 'Remove' }));

    expect(await screen.findByText(/Removing only forgets the entry/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText(/Removing only forgets the entry/)).toBeNull());
  });

  it('opens the locate dialog for a missing project, showing the path that vanished', async () => {
    useProjectsStore.setState({ projects: [project({ status: 'missing' })] });
    renderAt('/projects');

    await userEvent.click(within(row('Line 1')).getByRole('button', { name: 'Locate…' }));

    expect(
      await screen.findByText(/folder recorded for this project is missing/),
    ).toBeInTheDocument();
    expect(within(modal()!).getByText('/projects/line-1')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByText(/folder recorded for this project is missing/)).toBeNull(),
    );
  });
});

describe('manager shell', () => {
  it('signs out from the top bar', async () => {
    const logout = vi.fn().mockResolvedValue(undefined);
    stubManagerActions({ logout });
    renderAt('/projects');

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(logout).toHaveBeenCalled();
  });

  it('redirects an unknown manager path to the projects dashboard', () => {
    renderAt('/nowhere');

    expect(screen.getByRole('button', { name: '+ New project' })).toBeInTheDocument();
  });
});

describe('root redirect', () => {
  it('falls through to the projects dashboard when no default is running', async () => {
    useProjectsStore.setState({ projects: [project()], defaultProjectId: 'p1' });
    renderAt('/');

    expect(await screen.findByRole('button', { name: '+ New project' })).toBeInTheDocument();
  });

  it('jumps straight to the default project runtime when it is up', async () => {
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      assign,
      search: '',
    } as unknown as Location);
    useProjectsStore.setState({ defaultProjectId: 'p1' });
    useManagerStore.setState({ instances: { p1: instance() } });

    renderAt('/');

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/runtime/p1/'));
    expect(screen.queryByRole('button', { name: '+ New project' })).toBeNull();
  });
});

describe('sign-in round trip', () => {
  function stubSearch(search: string) {
    const replace = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      replace,
      search,
    } as unknown as Location);
    return replace;
  }

  it('returns to the project URL that was bounced to sign-in', async () => {
    const replace = stubSearch('?signIn=%2Feditor%2Fp1%2Fconfig');

    renderAt('/');

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/editor/p1/config'));
    expect(screen.queryByRole('button', { name: '+ New project' })).toBeNull();
  });

  it('ignores an off-site destination', async () => {
    const replace = stubSearch('?signIn=https%3A%2F%2Fevil.example%2F');

    renderAt('/projects');

    expect(await screen.findByRole('button', { name: '+ New project' })).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('settings page', () => {
  it('renders the device sections and polls system info', () => {
    vi.useFakeTimers();
    const loadSystemInfo = vi.fn().mockResolvedValue(undefined);
    const loadRuntimeHome = vi.fn().mockResolvedValue(undefined);
    stubManagerActions({ loadSystemInfo });
    stubProjectsActions({ loadRuntimeHome });
    useManagerStore.setState({ systemInfo: { uptime_seconds: 3661, python: '3.13.1', pid: 42 } });
    useProjectsStore.setState({ runtimeHome: '/home/op/NextHMI' });

    renderAt('/settings');

    expect(screen.getByText('System Information')).toBeInTheDocument();
    expect(screen.getByText('1h 1m 1s')).toBeInTheDocument();
    expect(screen.getByText('/home/op/NextHMI')).toBeInTheDocument();
    expect(screen.getByText('Security')).toBeInTheDocument();
    expect(loadRuntimeHome).toHaveBeenCalledTimes(1);

    expect(loadSystemInfo).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10000);
    expect(loadSystemInfo).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('opens the log viewer from the logs section', async () => {
    renderAt('/settings');

    await userEvent.click(screen.getByRole('button', { name: 'View logs' }));

    expect(within(await openModal()).getByText('Application logs')).toBeInTheDocument();
  });

  // The open-source build has no licence surface at all — that is both the
  // artifact rule and the trust claim the public licensing page makes.
  it('renders no licence panel, because the stub contributes no panels', () => {
    renderAt('/settings');

    expect(screen.queryByText('Device licenses')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy Device ID' })).toBeNull();
  });
});

describe('security section', () => {
  it('changes the device-admin password from the modal', async () => {
    const changePassword = vi.fn().mockResolvedValue(undefined);
    stubManagerActions({ changePassword });
    renderAt('/settings');

    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
    const dialog = await openModal();
    const fields = dialog.querySelectorAll('input[type="password"]');

    await userEvent.type(fields[0], 'old');
    await userEvent.type(fields[1], 'new');
    await userEvent.type(fields[2], 'new');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Change password' }));

    await waitFor(() => expect(changePassword).toHaveBeenCalledWith('old', 'new'));
    await waitFor(() => expect(modal()).toBeNull());
  });

  it('refuses a mismatched confirmation without calling the API', async () => {
    const changePassword = vi.fn().mockResolvedValue(undefined);
    stubManagerActions({ changePassword });
    renderAt('/settings');

    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
    const dialog = await openModal();
    const fields = dialog.querySelectorAll('input[type="password"]');

    await userEvent.type(fields[0], 'old');
    await userEvent.type(fields[1], 'new');
    await userEvent.type(fields[2], 'nope');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Change password' }));

    expect(await screen.findByText('New passwords do not match')).toBeInTheDocument();
    expect(changePassword).not.toHaveBeenCalled();
  });

  it('keeps the modal open and shows the reason when the current password is wrong', async () => {
    stubManagerActions({
      changePassword: vi.fn().mockRejectedValue(new Error('Wrong password')),
    });
    renderAt('/settings');

    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
    const dialog = await openModal();
    const fields = dialog.querySelectorAll('input[type="password"]');

    await userEvent.type(fields[0], 'bad');
    await userEvent.type(fields[1], 'new');
    await userEvent.type(fields[2], 'new');
    await userEvent.type(fields[2], '{Enter}');

    expect(await screen.findByText('Wrong password')).toBeInTheDocument();
    expect(modal()).not.toBeNull();
  });
});

// Only the two dashboard pages carry it: an operator at a wall panel cannot act
// on it, so the runtime and the editor stay clear.
describe('insecure-connection notice', () => {
  const NOTICE = /serving over the network without HTTPS/i;

  it('stands above the project list when the device answers on plain HTTP', async () => {
    vi.stubGlobal('isSecureContext', false);

    renderAt('/projects');

    expect(await screen.findByText(NOTICE)).toBeInTheDocument();
  });

  it('stands on the settings page as well', async () => {
    vi.stubGlobal('isSecureContext', false);

    renderAt('/settings');

    expect(await screen.findByText(NOTICE)).toBeInTheDocument();
  });

  // The gate is the screen the notice matters most on: the device-admin
  // password typed into it is the exposure the sentence describes.
  it('stands on the sign-in gate, which renders before any route does', () => {
    vi.stubGlobal('isSecureContext', false);
    useManagerStore.setState({ auth: 'needs-login' });

    renderAt('/projects');

    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
  });

  it('stands on the first-run setup gate too', () => {
    vi.stubGlobal('isSecureContext', false);
    useManagerStore.setState({ auth: 'needs-setup' });

    renderAt('/projects');

    expect(screen.getByRole('button', { name: 'Set password & continue' })).toBeInTheDocument();
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
  });

  it('drops the link on the settings page, where the HTTPS switch already is', async () => {
    vi.stubGlobal('isSecureContext', false);

    renderAt('/settings');

    expect(await screen.findByText(NOTICE)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Turn on HTTPS in Settings' })).toBeNull();
  });

  it('is absent on a secure context', async () => {
    vi.stubGlobal('isSecureContext', true);

    renderAt('/projects');

    expect(await screen.findByRole('button', { name: '+ New project' })).toBeInTheDocument();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});
