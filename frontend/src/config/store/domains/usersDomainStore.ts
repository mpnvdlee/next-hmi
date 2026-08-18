import { create } from 'zustand';
import { apiJson } from '@shared/utils/api';

export interface UserGroup {
  id: string;
  label: string;
}

export interface UserRecord {
  id: string;
  username: string;
  password: string;
  passwordSet?: boolean;
  groups: string[];
}

export interface UsersSettings {
  autoLoginName: string;
  configAccessGroups: string[];
}

export interface UsersDocument {
  settings: UsersSettings;
  groups: UserGroup[];
  users: UserRecord[];
}

export type UsersSelection =
  { type: 'settings' } | { type: 'group'; id: string } | { type: 'user'; id: string } | null;

interface UsersDomainState {
  data: UsersDocument | null;
  draft: UsersDocument | null;
  selection: UsersSelection;
  loadError: string | null;
  saveError: string | null;
  dirty: boolean;
  saving: boolean;
  _draftSeq: number;

  setSelection(sel: UsersSelection): void;
  load(): Promise<void>;
  ensureLoaded(): void;
  patchSettingsDraft(s: UsersSettings): void;
  patchGroupsDraft(groups: UserGroup[]): void;
  patchUsersDraft(users: UserRecord[]): void;
  deleteGroupDraft(id: string): void;
  deleteUserDraft(id: string): void;
  save(): Promise<void>;
  discard(): void;
}

let inFlight: Promise<void> | null = null;

export const useUsersDomainStore = create<UsersDomainState>((set, get) => ({
  data: null,
  draft: null,
  selection: null,
  loadError: null,
  saveError: null,
  dirty: false,
  saving: false,
  _draftSeq: 0,

  setSelection: (sel) => set({ selection: sel }),

  load: async () => {
    try {
      const data = await apiJson<UsersDocument>('/api/users');
      set((state) => ({
        data,
        draft: structuredClone(data),
        loadError: null,
        saveError: null,
        dirty: false,
        _draftSeq: state._draftSeq + 1,
      }));
    } catch (err) {
      console.error('[usersDomainStore] load failed:', err);
      set({ loadError: 'Could not load users.' });
    }
  },

  ensureLoaded: () => {
    if (get().data || inFlight) return;
    inFlight = get()
      .load()
      .finally(() => {
        inFlight = null;
      });
  },

  patchSettingsDraft: (s) => {
    const { draft } = get();
    if (!draft) return;
    set((state) => ({
      draft: { ...draft, settings: s },
      dirty: true,
      saveError: null,
      _draftSeq: state._draftSeq + 1,
    }));
  },

  patchGroupsDraft: (groups) => {
    const { draft } = get();
    if (!draft) return;
    set((state) => ({
      draft: { ...draft, groups },
      dirty: true,
      saveError: null,
      _draftSeq: state._draftSeq + 1,
    }));
  },

  patchUsersDraft: (users) => {
    const { draft } = get();
    if (!draft) return;
    set((state) => ({
      draft: { ...draft, users },
      dirty: true,
      saveError: null,
      _draftSeq: state._draftSeq + 1,
    }));
  },

  deleteGroupDraft: (id) => {
    const { draft } = get();
    if (!draft) return;
    const users = draft.users.map((user) => {
      const groups = user.groups.filter((groupId) => groupId !== id);
      return { ...user, groups: groups.length > 0 ? groups : ['guest'] };
    });
    set((state) => ({
      draft: {
        settings: {
          ...draft.settings,
          configAccessGroups: draft.settings.configAccessGroups.filter((groupId) => groupId !== id),
        },
        groups: draft.groups.filter((group) => group.id !== id),
        users,
      },
      dirty: true,
      saveError: null,
      _draftSeq: state._draftSeq + 1,
    }));
  },

  deleteUserDraft: (id) => {
    const { draft } = get();
    if (!draft) return;
    const deleted = draft.users.find((user) => user.id === id);
    set((state) => ({
      draft: {
        ...draft,
        settings:
          deleted?.username === draft.settings.autoLoginName
            ? { ...draft.settings, autoLoginName: 'guest' }
            : draft.settings,
        users: draft.users.filter((user) => user.id !== id),
      },
      dirty: true,
      saveError: null,
      _draftSeq: state._draftSeq + 1,
    }));
  },

  save: async () => {
    const { draft, dirty, _draftSeq } = get();
    if (!draft || !dirty) return;
    const document = structuredClone(draft);
    set({ saving: true, saveError: null });

    try {
      const saved = await apiJson<UsersDocument>('/api/users', {
        method: 'PUT',
        body: document,
      });
      set((state) =>
        state._draftSeq === _draftSeq
          ? {
              data: saved,
              draft: structuredClone(saved),
              dirty: false,
              saving: false,
              saveError: null,
            }
          : { data: saved, saving: false },
      );
    } catch (err) {
      console.error('[usersDomainStore] save failed:', err);
      set({ saving: false, saveError: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  discard: () => {
    const { data } = get();
    if (!data) return;
    set((state) => ({
      draft: structuredClone(data),
      dirty: false,
      saveError: null,
      _draftSeq: state._draftSeq + 1,
    }));
  },
}));
