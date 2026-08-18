/**
 * UsersTree — left sidebar for the UsersView.
 *
 * Two collapsible root nodes: "Users" and "User Groups".
 * Under "Users": a Settings row (global settings), then individual user leaves.
 * Under "User Groups": individual group leaves.
 *
 * Uses shared cfg-tree* classes (config.css) matching DatasourceTree /
 * DictionaryTree patterns.
 */

import { useState } from 'react';
import { Gear, IdentificationBadge, User, Users, UsersThree } from '@phosphor-icons/react';
import type { UserRecord, UserGroup, UsersSelection } from '@config/store/domains/usersDomainStore';
import { ContextMenu, ContextMenuItem } from '../../ui/ContextMenu';
import { TreeRowActionButton } from '../../ui/TreeAffordances';
import TreeRow from '../../ui/TreeRow';
import NameInputModal from '../../ui/NameInputModal';
import { useContextMenu } from '@config/hooks/useContextMenu';
import { useDeleteConfirm } from '@config/hooks/useDeleteConfirm';

interface Props {
  users: UserRecord[];
  groups: UserGroup[];
  selection: UsersSelection;
  onSelect(sel: UsersSelection): void;
  onAddUser(username: string): void;
  onAddGroup(id: string, label: string): void;
  onDeleteUser(id: string): void;
  onDeleteGroup(id: string): void;
}

// ── UsersTree ─────────────────────────────────────────────────────────────────

export default function UsersTree({
  users,
  groups,
  selection,
  onSelect,
  onAddUser,
  onAddGroup,
  onDeleteUser,
  onDeleteGroup,
}: Props) {
  const [usersExpanded, setUsersExpanded] = useState(true);
  const [groupsExpanded, setGroupsExpanded] = useState(true);

  // Add-modals
  const [addingUser, setAddingUser] = useState(false);
  const [addingGroup, setAddingGroup] = useState(false);

  // Delete-confirm
  type DeleteTarget =
    { kind: 'user'; id: string; name: string } | { kind: 'group'; id: string; name: string };
  const deleteConfirm = useDeleteConfirm<DeleteTarget>({
    message: (t) => `Delete ${t.kind} "${t.name}"? This cannot be undone.`,
    onConfirm: (t) => {
      if (t.kind === 'user') onDeleteUser(t.id);
      else onDeleteGroup(t.id);
    },
  });

  // Context menus
  const usersRootMenu = useContextMenu();
  const groupsRootMenu = useContextMenu();
  const userChildMenu = useContextMenu<{ id: string; name: string }>();
  const groupChildMenu = useContextMenu<{ id: string; name: string }>();

  // ── Derivations ─────────────────────────────────────────────────────────

  const settingsActive = selection?.type === 'settings';

  function isUserSelected(id: string) {
    return selection?.type === 'user' && selection.id === id;
  }

  function isGroupSelected(id: string) {
    return selection?.type === 'group' && selection.id === id;
  }

  // ── Handlers ────────────────────────────────────────────────────────────

  function handleUsersBtnClick(e: React.MouseEvent) {
    e.stopPropagation();
    usersRootMenu.close();
    setAddingUser(true);
  }

  function handleGroupsBtnClick(e: React.MouseEvent) {
    e.stopPropagation();
    groupsRootMenu.close();
    setAddingGroup(true);
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="cfg-tree">
      <div className="cfg-tree__scroll">
        {/* ── SETTINGS standalone root ── */}
        <TreeRow
          variant="group"
          selected={settingsActive}
          icon={<Gear size={14} className="cfg-tree-item__icon cfg-tree-item__icon--svg" />}
          label={<span className="cfg-tree-item__label">Settings</span>}
          onSelect={() => onSelect({ type: 'settings' })}
        />

        {/* ── USERS root node ── */}
        <TreeRow
          variant="group"
          toggle={{ open: usersExpanded, onClick: () => setUsersExpanded((v) => !v) }}
          icon={<Users size={14} className="cfg-tree-item__icon cfg-tree-item__icon--svg" />}
          label={<span className="cfg-tree-item__label">Users</span>}
          onSelect={() => setUsersExpanded((v) => !v)}
          onContextMenu={(e) => usersRootMenu.open(e, {})}
        >
          <span className="cfg-tree-item__count">{users.length}</span>
          <TreeRowActionButton title="Add user" onClick={handleUsersBtnClick}>
            +
          </TreeRowActionButton>
        </TreeRow>

        {usersExpanded && (
          <>
            {/* User leaves */}
            {users.map((u) => (
              <TreeRow
                key={u.id}
                depth={1}
                selected={isUserSelected(u.id)}
                icon={<User size={14} className="cfg-tree-item__icon cfg-tree-item__icon--svg" />}
                label={<span className="cfg-tree-item__label">{u.username}</span>}
                onSelect={() => onSelect({ type: 'user', id: u.id })}
                onContextMenu={(e) => userChildMenu.open(e, { id: u.id, name: u.username })}
              >
                {u.id !== 'guest' && (
                  <TreeRowActionButton
                    title={`Delete ${u.username}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteConfirm.ask({ kind: 'user', id: u.id, name: u.username });
                    }}
                  >
                    ×
                  </TreeRowActionButton>
                )}
              </TreeRow>
            ))}

            {users.length === 0 && (
              <div className="cfg-tree-section-empty">No users. Click + to add one.</div>
            )}
          </>
        )}

        {/* ── USER GROUPS root node ── */}
        <TreeRow
          variant="group"
          toggle={{ open: groupsExpanded, onClick: () => setGroupsExpanded((v) => !v) }}
          icon={<UsersThree size={14} className="cfg-tree-item__icon cfg-tree-item__icon--svg" />}
          label={<span className="cfg-tree-item__label">User Groups</span>}
          onSelect={() => setGroupsExpanded((v) => !v)}
          onContextMenu={(e) => groupsRootMenu.open(e, {})}
        >
          <span className="cfg-tree-item__count">{groups.length}</span>
          <TreeRowActionButton title="Add group" onClick={handleGroupsBtnClick}>
            +
          </TreeRowActionButton>
        </TreeRow>

        {groupsExpanded && (
          <>
            {groups.map((g) => (
              <TreeRow
                key={g.id}
                depth={1}
                selected={isGroupSelected(g.id)}
                icon={
                  <IdentificationBadge
                    size={14}
                    className="cfg-tree-item__icon cfg-tree-item__icon--svg"
                  />
                }
                label={<span className="cfg-tree-item__label">{g.label}</span>}
                onSelect={() => onSelect({ type: 'group', id: g.id })}
                onContextMenu={(e) => groupChildMenu.open(e, { id: g.id, name: g.label })}
              >
                {g.id !== 'guest' && (
                  <TreeRowActionButton
                    title={`Delete ${g.label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteConfirm.ask({ kind: 'group', id: g.id, name: g.label });
                    }}
                  >
                    ×
                  </TreeRowActionButton>
                )}
              </TreeRow>
            ))}

            {groups.length === 0 && (
              <div className="cfg-tree-section-empty">No groups. Click + to add one.</div>
            )}
          </>
        )}
      </div>

      {/* ── Context menus ── */}

      {usersRootMenu.state && (
        <ContextMenu
          x={usersRootMenu.state.x}
          y={usersRootMenu.state.y}
          onClose={usersRootMenu.close}
        >
          <ContextMenuItem
            onClick={() => {
              usersRootMenu.close();
              setAddingUser(true);
            }}
          >
            Add User…
          </ContextMenuItem>
        </ContextMenu>
      )}

      {groupsRootMenu.state && (
        <ContextMenu
          x={groupsRootMenu.state.x}
          y={groupsRootMenu.state.y}
          onClose={groupsRootMenu.close}
        >
          <ContextMenuItem
            onClick={() => {
              groupsRootMenu.close();
              setAddingGroup(true);
            }}
          >
            Add Group…
          </ContextMenuItem>
        </ContextMenu>
      )}

      {userChildMenu.state && (
        <ContextMenu
          x={userChildMenu.state.x}
          y={userChildMenu.state.y}
          onClose={userChildMenu.close}
        >
          {userChildMenu.state.id !== 'guest' ? (
            <ContextMenuItem
              danger
              onClick={() => {
                deleteConfirm.ask({
                  kind: 'user',
                  id: userChildMenu.state!.id,
                  name: userChildMenu.state!.name,
                });
                userChildMenu.close();
              }}
            >
              Delete "{userChildMenu.state.name}"…
            </ContextMenuItem>
          ) : (
            <span className="cfg-context-menu__item cfg-context-menu__item--empty">
              No actions available
            </span>
          )}
        </ContextMenu>
      )}

      {groupChildMenu.state && (
        <ContextMenu
          x={groupChildMenu.state.x}
          y={groupChildMenu.state.y}
          onClose={groupChildMenu.close}
        >
          {groupChildMenu.state.id !== 'guest' ? (
            <ContextMenuItem
              danger
              onClick={() => {
                deleteConfirm.ask({
                  kind: 'group',
                  id: groupChildMenu.state!.id,
                  name: groupChildMenu.state!.name,
                });
                groupChildMenu.close();
              }}
            >
              Delete "{groupChildMenu.state.name}"…
            </ContextMenuItem>
          ) : (
            <span className="cfg-context-menu__item cfg-context-menu__item--empty">
              No actions available
            </span>
          )}
        </ContextMenu>
      )}

      {/* ── Add modals ── */}

      {addingUser && (
        <NameInputModal
          title="New User"
          placeholder="Username…"
          onConfirm={(name) => {
            onAddUser(name);
            setAddingUser(false);
          }}
          onCancel={() => setAddingUser(false)}
        />
      )}

      {addingGroup && (
        <NameInputModal
          title="New User Group"
          placeholder="Group ID…"
          onConfirm={(name) => {
            onAddGroup(name, name);
            setAddingGroup(false);
          }}
          onCancel={() => setAddingGroup(false)}
        />
      )}

      {deleteConfirm.modal}
    </div>
  );
}
