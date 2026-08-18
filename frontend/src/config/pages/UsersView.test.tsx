import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useUsersDomainStore, type UsersDocument } from '../store/domains/usersDomainStore';
import UsersView from './UsersView';

vi.mock('../components/users/UsersPropertiesPanel', () => ({
  default: ({ selection }: { selection: { type: string; id?: string } | null }) => (
    <div data-testid="properties">
      {selection ? `${selection.type}${selection.id ? `:${selection.id}` : ''}` : 'none'}
    </div>
  ),
}));

const DOCUMENT: UsersDocument = {
  settings: { autoLoginName: 'guest', configAccessGroups: ['guest'] },
  groups: [
    { id: 'guest', label: 'Guest' },
    { id: 'operators', label: 'Operators' },
  ],
  users: [
    { id: 'guest', username: 'guest', password: '', groups: ['guest'] },
    { id: 'alice', username: 'alice', password: '', groups: ['operators'] },
  ],
};

function seed(overrides: Partial<ReturnType<typeof useUsersDomainStore.getState>> = {}) {
  useUsersDomainStore.setState({
    data: structuredClone(DOCUMENT),
    draft: structuredClone(DOCUMENT),
    selection: null,
    loadError: null,
    saveError: null,
    dirty: false,
    saving: false,
    _draftSeq: 0,
    ...overrides,
  });
}

/** The open modal — ModalShell renders no ARIA role, so address it by class. */
function modal(): HTMLElement | null {
  return document.querySelector('.cfg-modal');
}

beforeEach(() => {
  seed();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('UsersView draft lifetime', () => {
  it('preserves a pending edit through unmount and remount without reloading', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const first = render(<UsersView />);
    useUsersDomainStore.getState().patchSettingsDraft({
      autoLoginName: 'guest',
      configAccessGroups: [],
    });

    first.unmount();
    const second = render(<UsersView />);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(useUsersDomainStore.getState().draft?.settings.configAccessGroups).toEqual([]);
    expect(useUsersDomainStore.getState().dirty).toBe(true);
    second.unmount();
  });

  it('keeps the tree selection across a remount', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const first = render(<UsersView />);
    await userEvent.click(screen.getByText('alice'));
    first.unmount();

    render(<UsersView />);

    expect(screen.getByTestId('properties')).toHaveTextContent('user:alice');
  });

  it('fetches once when several mounts race the same load', () => {
    const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    seed({ data: null, draft: null });

    render(<UsersView />);
    render(<UsersView />);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('UsersView states', () => {
  it('shows a spinner until the draft is hydrated', () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    seed({ data: null, draft: null });

    const { container } = render(<UsersView />);

    expect(container.querySelector('.app-spinner')).not.toBeNull();
    expect(screen.queryByTestId('properties')).toBeNull();
  });

  it('shows the load error in place of the workspace', () => {
    seed({ data: null, draft: null, loadError: 'Could not load users.' });

    render(<UsersView />);

    expect(screen.getByText('Could not load users.')).toBeInTheDocument();
    expect(screen.queryByTestId('properties')).toBeNull();
  });

  it('renders users and groups from the draft, not the last-saved document', () => {
    useUsersDomainStore
      .getState()
      .patchUsersDraft([
        ...DOCUMENT.users,
        { id: 'bob', username: 'bob', password: '', groups: ['guest'] },
      ]);

    render(<UsersView />);

    expect(screen.getByText('bob')).toBeInTheDocument();
    expect(screen.getByText('Operators')).toBeInTheDocument();
  });
});

describe('UsersView tree editing', () => {
  it('adds a user with a slugged id, seeded into guest, and selects it', async () => {
    render(<UsersView />);

    await userEvent.click(screen.getByTitle('Add user'));
    const dialog = modal() as HTMLElement;
    await userEvent.type(within(dialog).getByRole('textbox'), 'Bob Jones');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

    const added = useUsersDomainStore
      .getState()
      .draft?.users.find((u) => u.username === 'Bob Jones');
    expect(added).toMatchObject({ id: 'bob-jones', groups: ['guest'] });
    await waitFor(() =>
      expect(screen.getByTestId('properties')).toHaveTextContent('user:bob-jones'),
    );
  });

  it('adds a group and selects it', async () => {
    render(<UsersView />);

    await userEvent.click(screen.getByTitle('Add group'));
    const dialog = modal() as HTMLElement;
    await userEvent.type(within(dialog).getByRole('textbox'), 'Maintenance');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(useUsersDomainStore.getState().draft?.groups.map((g) => g.id)).toContain(
        'Maintenance',
      ),
    );
    expect(screen.getByTestId('properties')).toHaveTextContent('group:Maintenance');
  });

  it('deletes a user and falls back to Settings from a selection that pointed at it', async () => {
    render(<UsersView />);

    await userEvent.click(screen.getByText('alice'));
    expect(screen.getByTestId('properties')).toHaveTextContent('user:alice');

    await userEvent.click(screen.getByTitle('Delete alice'));
    await userEvent.click(within(modal() as HTMLElement).getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(useUsersDomainStore.getState().draft?.users.map((u) => u.id)).toEqual(['guest']),
    );
    await waitFor(() => expect(screen.getByTestId('properties')).toHaveTextContent('settings'));
  });

  it('keeps an unrelated selection when another user is deleted', async () => {
    render(<UsersView />);

    await userEvent.click(screen.getByText('guest', { selector: '.cfg-tree-item__label' }));
    useUsersDomainStore.getState().setSelection({ type: 'user', id: 'guest' });

    await userEvent.click(screen.getByTitle('Delete alice'));
    await userEvent.click(within(modal() as HTMLElement).getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(useUsersDomainStore.getState().draft?.users.map((u) => u.id)).toEqual(['guest']),
    );
    expect(screen.getByTestId('properties')).toHaveTextContent('user:guest');
  });

  it('offers no delete affordance for the built-in guest group or user', () => {
    render(<UsersView />);

    expect(screen.getByTitle('Delete Operators')).toBeInTheDocument();
    expect(screen.queryByTitle('Delete Guest')).toBeNull();
    expect(screen.queryByTitle('Delete guest')).toBeNull();
  });

  it('deletes a group and falls back to Settings from a selection that pointed at it', async () => {
    render(<UsersView />);
    useUsersDomainStore.setState({ selection: { type: 'group', id: 'operators' } });

    await userEvent.click(screen.getByTitle('Delete Operators'));
    await userEvent.click(within(modal() as HTMLElement).getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(useUsersDomainStore.getState().draft?.groups.map((g) => g.id)).toEqual(['guest']),
    );
    await waitFor(() => expect(screen.getByTestId('properties')).toHaveTextContent('settings'));
  });

  it('selects the settings row', async () => {
    render(<UsersView />);

    await userEvent.click(screen.getByText('Settings'));

    expect(screen.getByTestId('properties')).toHaveTextContent('settings');
  });
});
