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
import BoolButtonGroup from '../../ui/BoolButtonGroup';
import { useTranslationStore } from '@shared/store/translationStore';
import type {
  UsersDocument,
  UsersSelection,
  UserGroup,
  UserLocks,
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
        users={doc.users}
        groups={doc.groups}
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
  users,
  groups,
  onChange,
}: {
  settings: UsersSettings;
  users: UserRecord[];
  groups: UserGroup[];
  onChange(s: UsersSettings): void;
}) {
  const adminGroups = settings.userAdminGroups ?? [];
  const adminOptions = groups.filter((g) => g.id !== 'guest');
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
        <div className="cfg-section__title">Runtime user management</div>
        <FieldGroup
          label="User admins"
          description="Members of these groups may add, change and delete users from the runtime, with the Update User and Delete User actions. Accounts changed on a machine are kept when this project replaces it in a transfer; groups and settings come from this project."
          tier={3}
          badge={<PropertySourceBadge source="static" variant="cap" />}
          summary={<GroupsSummary value={adminGroups} options={adminOptions} emptyLabel="nobody" />}
          kindLabel={<KindLabel>Groups</KindLabel>}
          drawerTitle="User admins"
        >
          <GroupsEditor
            value={adminGroups}
            options={adminOptions}
            showIds
            onChange={(v) =>
              onChange({ ...settings, userAdminGroups: Array.isArray(v) ? (v as string[]) : [] })
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

      <UserRuntimeSection user={user} onChange={onChange} />
    </div>
  );
}

const LOCK_ROWS: { key: keyof UserLocks; label: string; description: string }[] = [
  { key: 'delete', label: 'Prevent delete', description: 'The runtime cannot delete this user.' },
  {
    key: 'password',
    label: 'Lock password',
    description: 'The runtime cannot change this password, not even the user themselves.',
  },
  { key: 'groups', label: 'Lock groups', description: "The runtime cannot change this user's groups." },
];

function UserRuntimeSection({
  user,
  onChange,
}: {
  user: UserRecord;
  onChange(u: UserRecord): void;
}) {
  const languages = useTranslationStore((s) => s.languages);
  const language = user.language ?? '';
  const setLock = (key: keyof UserLocks, on: boolean) =>
    onChange({ ...user, locked: { ...user.locked, [key]: on } });
  return (
    <div className="cfg-section">
      <div className="cfg-section__title">Runtime</div>
      <PropRow label="Language" description="Switches the HMI to this language when the user signs in.">
        <Select value={language} onChange={(v) => onChange({ ...user, language: v })}>
          <option value="">(none)</option>
          {/* A code no longer in the dictionaries still shows, rather than reading as none. */}
          {language && !languages.some((l) => l.code === language) && (
            <option value={language}>{language}</option>
          )}
          {languages.map((l) => (
            <option key={l.code} value={l.code}>
              {l.code}
            </option>
          ))}
        </Select>
      </PropRow>
      {user.id !== 'guest' &&
        LOCK_ROWS.map(({ key, label, description }) => (
          <PropRow key={key} label={label} description={description} sourceless>
            <BoolButtonGroup value={Boolean(user.locked?.[key])} onChange={(on) => setLock(key, on)} />
          </PropRow>
        ))}
    </div>
  );
}
