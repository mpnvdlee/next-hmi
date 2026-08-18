/**
 * AlarmTree — left sidebar for the AlarmsView.
 *
 * Expandable groups with alarm leaf nodes, above a search bar that filters the
 * tree and highlights the matches.
 * Uses shared cfg-tree* classes (config.css) matching UsersTree / DatasourceTree patterns.
 */

import { useMemo, useState } from 'react';
import { Folder, Warning, Info, WarningCircle } from '@phosphor-icons/react';
import type { AlarmConfig, AlarmLevel } from '@shared/types/alarm';
import type { AlarmSelection } from '@config/store/alarmConfigStore';
import TreeRow from '../../ui/TreeRow';
import TreeSearchBar from '../../ui/TreeSearchBar';
import { ContextMenu, ContextMenuItem } from '../../ui/ContextMenu';
import NameInputModal from '../../ui/NameInputModal';
import { resolveAlarmString } from '../alarmDisplayUtils';
import { alarmGroupTreeLabel, alarmTreeLabel, filterAlarmGroups } from '../alarmSearch';
import {
  TreeSearchHighlight,
  TreeSearchQueryProvider,
} from '../../editor/WidgetTree/TreeSearchHighlight';
import { withDotSearchSeparators } from '@shared/utils/search';
import { useContextMenu } from '@config/hooks/useContextMenu';
import { useDeleteConfirm } from '@config/hooks/useDeleteConfirm';
import { useToggleSet } from '@shared/hooks/useToggleSet';

interface Props {
  config: AlarmConfig;
  selection: AlarmSelection;
  onSelect(sel: AlarmSelection): void;
  onAddGroup(title: string): void;
  onAddAlarm(groupId: string): void;
  onDeleteGroup(id: string): void;
  onDeleteAlarm(alarmId: string): void;
}

function levelIcon(level: AlarmLevel) {
  switch (level) {
    case 'error':
      return <WarningCircle size={14} color="var(--cfg-danger-fg)" />;
    case 'warning':
      return <Warning size={14} color="var(--cfg-warning-strong)" />;
    case 'info':
      return <Info size={14} color="var(--cfg-accent)" />;
  }
}

export default function AlarmTree({
  config,
  selection,
  onSelect,
  onAddGroup,
  onAddAlarm,
  onDeleteGroup,
  onDeleteAlarm,
}: Props) {
  const [expandedGroups, toggleGroup, setExpandedGroups] = useToggleSet<string>(
    config.groups.map((g) => g.id),
  );
  const [addingGroup, setAddingGroup] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const groupMenu = useContextMenu<{ id: string; name: string }>();
  const alarmMenu = useContextMenu<{ id: string; name: string }>();
  type DeleteTarget =
    { kind: 'group'; id: string; name: string } | { kind: 'alarm'; id: string; name: string };
  const deleteConfirm = useDeleteConfirm<DeleteTarget>({
    message: (t) =>
      `Are you sure you want to delete "${t.name}"?${t.kind === 'group' ? ' All alarms in this group will also be deleted.' : ''}`,
    onConfirm: (t) => {
      if (t.kind === 'group') onDeleteGroup(t.id);
      else onDeleteAlarm(t.id);
    },
  });

  function isGroupSelected(id: string) {
    return selection?.type === 'group' && selection.id === id;
  }

  function isAlarmSelected(id: string) {
    return selection?.type === 'alarm' && selection.id === id;
  }

  const isSearching = searchQuery.trim().length > 0;
  const groups = useMemo(
    () => filterAlarmGroups(config.groups, searchQuery),
    [config.groups, searchQuery],
  );

  return (
    <TreeSearchQueryProvider query={withDotSearchSeparators(searchQuery)}>
      <div className="cfg-tree">
        <TreeSearchBar
          value={searchQuery}
          onChange={setSearchQuery}
          label="Search alarm tree"
          shortcutDisabled={addingGroup || groupMenu.state !== null || alarmMenu.state !== null}
          onCollapseAll={() => {
            // A search force-expands the tree, so the collapse would be invisible.
            setSearchQuery('');
            setExpandedGroups(new Set());
          }}
        />
        <div className="cfg-tree__scroll">
          {groups.map((group) => {
            // Search filters the tree down to what matched, so every branch it kept opens.
            const expanded = isSearching || expandedGroups.has(group.id);
            return (
              <div key={group.id}>
                {/* Group row */}
                <TreeRow
                  variant="group"
                  selected={isGroupSelected(group.id)}
                  toggle={{ open: expanded, onClick: () => toggleGroup(group.id) }}
                  icon={
                    <Folder size={14} className="cfg-tree-item__icon cfg-tree-item__icon--svg" />
                  }
                  label={
                    <span className="cfg-tree-item__label">
                      <TreeSearchHighlight text={alarmGroupTreeLabel(group)} />
                    </span>
                  }
                  onSelect={() => onSelect({ type: 'group', id: group.id })}
                  onContextMenu={(e) => groupMenu.open(e, { id: group.id, name: group.title })}
                >
                  <span className="cfg-tree-item__count">{group.alarms.length}</span>
                </TreeRow>

                {/* Alarm leaves */}
                {expanded && (
                  <>
                    {group.alarms.map((alarm) => (
                      <TreeRow
                        key={alarm.id}
                        depth={1}
                        selected={isAlarmSelected(alarm.id)}
                        icon={
                          <span className="cfg-tree-item__icon cfg-tree-item__icon--svg">
                            {levelIcon(alarm.level)}
                          </span>
                        }
                        label={
                          <span className="cfg-tree-item__label">
                            <TreeSearchHighlight text={alarmTreeLabel(alarm)} />
                          </span>
                        }
                        onSelect={() => onSelect({ type: 'alarm', id: alarm.id })}
                        onContextMenu={(e) =>
                          alarmMenu.open(e, { id: alarm.id, name: resolveAlarmString(alarm.title) })
                        }
                      />
                    ))}

                    {group.alarms.length === 0 && (
                      <div className="cfg-tree-section-empty">No alarms yet.</div>
                    )}

                    {/* Add alarm row — hidden while a search narrows the group. */}
                    {!isSearching && (
                      <TreeRow
                        depth={1}
                        dimmed
                        label={<span className="cfg-tree-item__label">+ Add Alarm</span>}
                        onSelect={() => onAddAlarm(group.id)}
                      />
                    )}
                  </>
                )}
              </div>
            );
          })}

          {groups.length === 0 && (
            <div className="cfg-tree-section-empty">
              {isSearching ? 'No alarms match' : 'No alarm groups. Add one to get started.'}
            </div>
          )}

          {/* Add group button */}
          {!isSearching && (
            <TreeRow
              variant="group"
              dimmed
              label={<span className="cfg-tree-item__label">+ Add Group</span>}
              onSelect={() => setAddingGroup(true)}
            />
          )}
        </div>

        {/* Context menus */}
        {groupMenu.state && (
          <ContextMenu x={groupMenu.state.x} y={groupMenu.state.y} onClose={groupMenu.close}>
            <ContextMenuItem
              danger
              onClick={() => {
                deleteConfirm.ask({
                  kind: 'group',
                  id: groupMenu.state!.id,
                  name: groupMenu.state!.name,
                });
                groupMenu.close();
              }}
            >
              Delete "{groupMenu.state.name}"…
            </ContextMenuItem>
          </ContextMenu>
        )}

        {alarmMenu.state && (
          <ContextMenu x={alarmMenu.state.x} y={alarmMenu.state.y} onClose={alarmMenu.close}>
            <ContextMenuItem
              danger
              onClick={() => {
                deleteConfirm.ask({
                  kind: 'alarm',
                  id: alarmMenu.state!.id,
                  name: alarmMenu.state!.name,
                });
                alarmMenu.close();
              }}
            >
              Delete "{alarmMenu.state.name}"…
            </ContextMenuItem>
          </ContextMenu>
        )}

        {/* Modals */}
        {addingGroup && (
          <NameInputModal
            title="New Alarm Group"
            placeholder="Group name…"
            onConfirm={(name) => {
              onAddGroup(name);
              setAddingGroup(false);
            }}
            onCancel={() => setAddingGroup(false)}
          />
        )}

        {deleteConfirm.modal}
      </div>
    </TreeSearchQueryProvider>
  );
}
