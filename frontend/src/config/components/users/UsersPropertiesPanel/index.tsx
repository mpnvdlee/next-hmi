import './style.css';
import PanelHeader from '../../ui/PanelHeader';
import PropertiesEmpty from '../../ui/PropertiesEmpty';
import PropRow from '../../ui/PropRow';
import ReadOnlyValue from '../../ui/ReadOnlyValue';
import TextField from '../../ui/TextField';
import FieldGroup from '../../ui/FieldGroup';
import PropertySourceBadge from '../../editor/PropertySourceSelector/PropertySourceBadge';
import GroupsEditor, { GroupsSummary } from '../../editor/PropertiesPanel/GroupsEditor';
import { KindLabel } from '../../editor/PropertySourceEditor/editors/shared';
import Select from '../../ui/Select';
import type {
  UsersDocument,
  UsersSelection,
  UserGroup,
  UserRecord,
  UsersSettings,
} from '../../../store/domains/usersDomainStore';

interface Props {
  doc: UsersDocument;
  selection: UsersSelection;
  onPatchSettings(s: UsersSettings): void;
  onPatchGroup(group: UserGroup): void;
  onPatchUser(user: UserRecord): void;
}

export default function UsersPropertiesPanel({
  doc,
  selection,
  onPatchSettings,
  onPatchGroup,
  onPatchUser,
}: Props) {
  if (!selection) {
    return <PropertiesEmpty>Select a user or group to view its properties.</PropertiesEmpty>;
  }

  if (selection.type === 'settings') {
    return (
      <SettingsPanel
        settings={doc.settings}
        groups={doc.groups}
        users={doc.users}
        onChange={onPatchSettings}
      />
    );
  }

  if (selection.type === 'group') {
    const group = doc.groups.find((g) => g.id === selection.id);
    if (!group) return null;
    return <GroupPanel group={group} onChange={onPatchGroup} />;
  }

  if (selection.type === 'user') {
    const user = doc.users.find((u) => u.id === selection.id);
    if (!user) return null;
    return <UserPanel user={user} groups={doc.groups} onChange={onPatchUser} />;
  }

  return null;
}

// ── Settings Panel ─────────────────────────────────────────────────────────

function SettingsPanel({
  settings,
  groups,
  users,
  onChange,
}: {
  settings: UsersSettings;
  groups: UserGroup[];
  users: UserRecord[];
  onChange(s: UsersSettings): void;
}) {
  return (
    <div className="cfg-ds-props">
      <PanelHeader kind="global" name="Settings" />

      <div className="cfg-section">
        <div className="cfg-section__title">Auto-login</div>
        <PropRow label="User">
          <Select
            value={settings.autoLoginName}
            onChange={(v) => onChange({ ...settings, autoLoginName: v })}
          >
            {users.map((u) => (
              <option key={u.id} value={u.username}>
                {u.username}
              </option>
            ))}
          </Select>
        </PropRow>
      </div>

      <div className="cfg-section">
        <div className="cfg-section__title">Config Access</div>
        <FieldGroup
          label="Allowed groups"
          description="Users must belong to at least one of these groups to access the config."
          tier={3}
          badge={<PropertySourceBadge source="static" variant="cap" />}
          summary={
            <GroupsSummary
              value={settings.configAccessGroups}
              options={groups}
              emptyLabel="nobody"
            />
          }
          kindLabel={<KindLabel>Groups</KindLabel>}
          drawerTitle="Allowed groups"
        >
          <GroupsEditor
            value={settings.configAccessGroups}
            options={groups}
            showIds
            onChange={(v) =>
              onChange({ ...settings, configAccessGroups: Array.isArray(v) ? (v as string[]) : [] })
            }
          />
        </FieldGroup>
      </div>
    </div>
  );
}

// ── Group Panel ────────────────────────────────────────────────────────────

function GroupPanel({ group, onChange }: { group: UserGroup; onChange(g: UserGroup): void }) {
  return (
    <div className="cfg-ds-props">
      <PanelHeader kind="user group" name={group.label} />

      <div className="cfg-section">
        <div className="cfg-section__title">Identity</div>

        <PropRow label="ID" sourceless>
          <ReadOnlyValue mono>{group.id}</ReadOnlyValue>
        </PropRow>

        <PropRow label="Label" sourceless>
          <TextField value={group.label} onCommit={(label) => onChange({ ...group, label })} />
        </PropRow>
      </div>
    </div>
  );
}

// ── User Panel ─────────────────────────────────────────────────────────────

function UserPanel({
  user,
  groups,
  onChange,
}: {
  user: UserRecord;
  groups: UserGroup[];
  onChange(u: UserRecord): void;
}) {
  return (
    <div className="cfg-ds-props">
      <PanelHeader kind="user" name={user.username} />

      <div className="cfg-section">
        <div className="cfg-section__title">Credentials</div>

        <PropRow label="Username" sourceless>
          <TextField
            value={user.username}
            onCommit={(username) => onChange({ ...user, username })}
            disabled={user.id === 'guest'}
          />
        </PropRow>

        <PropRow label="Password">
          <TextField
            type="password"
            value={user.password}
            onCommit={(password) =>
              onChange({ ...user, password, passwordSet: password.length > 0 })
            }
            placeholder={user.passwordSet ? '(unchanged)' : '(no password)'}
            disabled={user.id === 'guest'}
          />
        </PropRow>
      </div>

      <div className="cfg-section">
        <div className="cfg-section__title">Group Membership</div>
        <FieldGroup
          label="Groups"
          description="Every user belongs to at least one group, so the last one cannot be removed."
          tier={3}
          badge={<PropertySourceBadge source="static" variant="cap" />}
          summary={<GroupsSummary value={user.groups} options={groups} emptyLabel="none" />}
          kindLabel={<KindLabel>Groups</KindLabel>}
          drawerTitle="Groups"
        >
          <GroupsEditor
            value={user.groups}
            options={groups}
            showIds
            requireOne
            onChange={(v) => onChange({ ...user, groups: Array.isArray(v) ? (v as string[]) : [] })}
          />
        </FieldGroup>
      </div>
    </div>
  );
}
