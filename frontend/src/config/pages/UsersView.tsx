import { useEffect, useCallback } from 'react';
import ConfigLayout from '../components/ui/ConfigLayout';
import UsersTree from '../components/users/UsersTree';
import UsersPropertiesPanel from '../components/users/UsersPropertiesPanel';
import { useUsersDomainStore } from '../store/domains/usersDomainStore';
import type { UserGroup, UserRecord } from '../store/domains/usersDomainStore';
import { slugId } from '@shared/utils/id';
import ConfigWorkspace from '../components/ui/ConfigWorkspace';

export default function UsersView() {
  const draft = useUsersDomainStore((s) => s.draft);
  const selection = useUsersDomainStore((s) => s.selection);
  const loadError = useUsersDomainStore((s) => s.loadError);
  const setSelection = useUsersDomainStore((s) => s.setSelection);
  const ensureLoaded = useUsersDomainStore((s) => s.ensureLoaded);
  const patchSettingsDraft = useUsersDomainStore((s) => s.patchSettingsDraft);
  const patchGroupsDraft = useUsersDomainStore((s) => s.patchGroupsDraft);
  const patchUsersDraft = useUsersDomainStore((s) => s.patchUsersDraft);
  const deleteGroupDraft = useUsersDomainStore((s) => s.deleteGroupDraft);
  const deleteUserDraft = useUsersDomainStore((s) => s.deleteUserDraft);

  useEffect(() => {
    ensureLoaded();
  }, [ensureLoaded]);

  // Same reason as the other tree views. Settings is the tree's first row and
  // always present, so it is the landing spot rather than an arbitrary user.
  useEffect(() => {
    if (!selection && draft) setSelection({ type: 'settings' });
  }, [draft, selection, setSelection]);

  const handleAddGroup = useCallback(
    (id: string, label: string) => {
      if (!draft) return;
      patchGroupsDraft([...draft.groups, { id, label }]);
      setSelection({ type: 'group', id });
    },
    [draft, patchGroupsDraft, setSelection],
  );

  const handleDeleteGroup = useCallback(
    (id: string) => {
      if (id === 'guest') return;
      deleteGroupDraft(id);
      if (selection && selection.type === 'group' && selection.id === id) {
        setSelection(null);
      }
    },
    [deleteGroupDraft, selection, setSelection],
  );

  const handleAddUser = useCallback(
    (username: string) => {
      if (!draft) return;
      const id = slugId(
        username || 'user',
        draft.users.map((u) => u.id),
      );
      const newUser: UserRecord = { id, username, password: '', groups: ['guest'] };
      patchUsersDraft([...draft.users, newUser]);
      setSelection({ type: 'user', id });
    },
    [draft, patchUsersDraft, setSelection],
  );

  const handleDeleteUser = useCallback(
    (id: string) => {
      if (id === 'guest') return;
      deleteUserDraft(id);
      if (selection && selection.type === 'user' && selection.id === id) {
        setSelection(null);
      }
    },
    [deleteUserDraft, selection, setSelection],
  );

  const handlePatchGroup = useCallback(
    (updatedGroup: UserGroup) => {
      if (!draft) return;
      patchGroupsDraft(draft.groups.map((g) => (g.id === updatedGroup.id ? updatedGroup : g)));
    },
    [draft, patchGroupsDraft],
  );

  const handlePatchUser = useCallback(
    (updatedUser: UserRecord) => {
      if (!draft) return;
      patchUsersDraft(draft.users.map((u) => (u.id === updatedUser.id ? updatedUser : u)));
    },
    [draft, patchUsersDraft],
  );

  if (loadError) {
    return <ConfigWorkspace title="Users" loadError={loadError} />;
  }

  if (!draft) {
    return <ConfigWorkspace title="Users" loading />;
  }

  return (
    <ConfigLayout
      storageKey="users"
      left={
        <UsersTree
          users={draft.users}
          groups={draft.groups}
          selection={selection}
          onSelect={setSelection}
          onAddUser={handleAddUser}
          onAddGroup={handleAddGroup}
          onDeleteUser={handleDeleteUser}
          onDeleteGroup={handleDeleteGroup}
        />
      }
      center={
        <ConfigWorkspace title="Users">
          <div className="cfg-panel-empty">
            Select a user or group in the tree to view its properties.
          </div>
        </ConfigWorkspace>
      }
      right={
        <UsersPropertiesPanel
          doc={draft}
          selection={selection}
          onPatchSettings={patchSettingsDraft}
          onPatchGroup={handlePatchGroup}
          onPatchUser={handlePatchUser}
        />
      }
    />
  );
}
