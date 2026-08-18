import { useProjectStore } from '@shared/store/projectStore';
import { useUsersDomainStore, type UsersDocument } from './usersDomainStore';

const BASE_DOCUMENT: UsersDocument = {
  settings: { autoLoginName: 'guest', configAccessGroups: ['admin'] },
  groups: [
    { id: 'guest', label: 'Guest' },
    { id: 'admin', label: 'Admin' },
  ],
  users: [
    { id: 'guest', username: 'guest', password: '', groups: ['guest'] },
    { id: 'admin', username: 'admin', password: '', passwordSet: true, groups: ['admin'] },
  ],
};

describe('usersDomainStore security drafts', () => {
  beforeEach(() => {
    useUsersDomainStore.setState({
      data: structuredClone(BASE_DOCUMENT),
      draft: structuredClone(BASE_DOCUMENT),
      selection: null,
      loadError: null,
      saveError: null,
      dirty: false,
      saving: false,
      _draftSeq: 0,
    });
    useProjectStore.setState({
      dirty: false,
      _dirtySeq: 0,
      past: [],
      future: [],
      _saveCallbacks: new Map(),
      _snapshotExtensions: new Map(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps edits out of project dirty state, save callbacks, and undo snapshots', () => {
    useProjectStore.getState().pushSnapshot();
    const editedUsers = structuredClone(BASE_DOCUMENT.users);
    editedUsers[1].password = 'new-secret';

    useUsersDomainStore.getState().patchUsersDraft(editedUsers);

    expect(useUsersDomainStore.getState().dirty).toBe(true);
    expect(useProjectStore.getState().dirty).toBe(false);
    expect(useProjectStore.getState()._saveCallbacks.has('users')).toBe(false);

    useProjectStore.getState().undo();
    expect(useUsersDomainStore.getState().draft?.users[1].password).toBe('new-secret');
  });

  it('does not reload or orphan a draft when another view ensures users are loaded', () => {
    const editedGroups = structuredClone(BASE_DOCUMENT.groups);
    editedGroups[1].label = 'Security admins';
    useUsersDomainStore.getState().patchGroupsDraft(editedGroups);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    useUsersDomainStore.getState().ensureLoaded();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(useUsersDomainStore.getState().draft?.groups[1].label).toBe('Security admins');
    expect(useUsersDomainStore.getState().dirty).toBe(true);
  });

  it('keeps settings and memberships valid when deleting a referenced group', () => {
    useUsersDomainStore.getState().deleteGroupDraft('admin');

    const draft = useUsersDomainStore.getState().draft;
    expect(draft?.settings.configAccessGroups).toEqual([]);
    expect(draft?.users[1].groups).toEqual(['guest']);
  });

  it('saves the complete document only through the explicit security save', async () => {
    const editedGroups = structuredClone(BASE_DOCUMENT.groups);
    editedGroups[1].label = 'Security admins';
    useUsersDomainStore.getState().patchGroupsDraft(editedGroups);
    const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => JSON.parse(String(options?.body)) as UsersDocument,
    }));
    vi.stubGlobal('fetch', fetchMock);

    await useUsersDomainStore.getState().save();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/users',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(useUsersDomainStore.getState().data?.groups[1].label).toBe('Security admins');
    expect(useUsersDomainStore.getState().dirty).toBe(false);
    expect(useUsersDomainStore.getState().saving).toBe(false);
    const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as UsersDocument;
    expect(sent.users[1].password).toBe('');
  });

  it('submits an intentional password change and clears it from the saved draft', async () => {
    const editedUsers = structuredClone(BASE_DOCUMENT.users);
    editedUsers[1].password = 'new-secret';
    useUsersDomainStore.getState().patchUsersDraft(editedUsers);
    const saved = structuredClone(BASE_DOCUMENT);
    saved.users[1].passwordSet = true;
    const fetchMock = vi.fn(async (_url: string, _options?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => saved,
    }));
    vi.stubGlobal('fetch', fetchMock);

    await useUsersDomainStore.getState().save();

    const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as UsersDocument;
    expect(sent.users[1].password).toBe('new-secret');
    expect(useUsersDomainStore.getState().draft?.users[1].password).toBe('');
    expect(useUsersDomainStore.getState().draft?.users[1].passwordSet).toBe(true);
  });

  it('discards a draft back to the last saved document without writing', () => {
    const editedGroups = structuredClone(BASE_DOCUMENT.groups);
    editedGroups[1].label = 'Discard me';
    useUsersDomainStore.getState().patchGroupsDraft(editedGroups);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    useUsersDomainStore.getState().discard();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(useUsersDomainStore.getState().draft).toEqual(BASE_DOCUMENT);
    expect(useUsersDomainStore.getState().dirty).toBe(false);
  });

  it('retains the dirty draft and exposes the error when save fails', async () => {
    const editedUsers = structuredClone(BASE_DOCUMENT.users);
    editedUsers[1].password = 'unsaved-secret';
    useUsersDomainStore.getState().patchUsersDraft(editedUsers);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({ detail: 'security save failed' }),
      })),
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(useUsersDomainStore.getState().save()).rejects.toThrow('security save failed');

    expect(useUsersDomainStore.getState().draft?.users[1].password).toBe('unsaved-secret');
    expect(useUsersDomainStore.getState().dirty).toBe(true);
    expect(useUsersDomainStore.getState().saving).toBe(false);
    expect(useUsersDomainStore.getState().saveError).toBe('security save failed');
  });
});
