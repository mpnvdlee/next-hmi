import { useEffect } from 'react';
import { useTranslations } from '@shared/hooks/useTranslations';
import ConfigLayout from '../components/ui/ConfigLayout';
import AlarmTree from '../components/alarms/AlarmTree';
import AlarmPropertiesPanel from '../components/alarms/AlarmPropertiesPanel';
import AlarmPopupPreviewPanel from '../components/alarms/AlarmPopupPreviewPanel';
import { useAlarmConfigStore } from '../store/alarmConfigStore';
import { useUsersDomainStore } from '../store/domains/usersDomainStore';
import ConfigWorkspace from '../components/ui/ConfigWorkspace';

export default function AlarmsView() {
  useTranslations();
  const config = useAlarmConfigStore((s) => s.config);
  const selection = useAlarmConfigStore((s) => s.selection);
  const loadError = useAlarmConfigStore((s) => s.loadError);
  const setSelection = useAlarmConfigStore((s) => s.setSelection);
  const load = useAlarmConfigStore((s) => s.load);
  const addGroup = useAlarmConfigStore((s) => s.addGroup);
  const addAlarm = useAlarmConfigStore((s) => s.addAlarm);
  const patchGroup = useAlarmConfigStore((s) => s.patchGroup);
  const patchAlarm = useAlarmConfigStore((s) => s.patchAlarm);
  const deleteGroup = useAlarmConfigStore((s) => s.deleteGroup);
  const deleteAlarm = useAlarmConfigStore((s) => s.deleteAlarm);

  // Load users for ack_groups
  const ensureUsersLoaded = useUsersDomainStore((s) => s.ensureLoaded);

  useEffect(() => {
    void load();
    ensureUsersLoaded();
  }, [load, ensureUsersLoaded]);

  // Open on the first alarm instead of an empty preview behind a "select an
  // alarm" message. Falls back to the group when it holds no alarms yet.
  useEffect(() => {
    if (selection || !config) return;
    const group = config.groups[0];
    if (!group) return;
    const alarm = group.alarms[0];
    setSelection(alarm ? { type: 'alarm', id: alarm.id } : { type: 'group', id: group.id });
  }, [config, selection, setSelection]);

  if (loadError) {
    return <ConfigWorkspace title="Alarms" loadError={loadError} />;
  }

  if (!config) {
    return <ConfigWorkspace title="Alarms" loading />;
  }

  return (
    <ConfigLayout
      storageKey="alarms"
      left={
        <AlarmTree
          config={config}
          selection={selection}
          onSelect={setSelection}
          onAddGroup={addGroup}
          onAddAlarm={addAlarm}
          onDeleteGroup={deleteGroup}
          onDeleteAlarm={deleteAlarm}
        />
      }
      center={
        <ConfigWorkspace title="Alarms">
          <AlarmPopupPreviewPanel config={config} selection={selection} />
        </ConfigWorkspace>
      }
      right={
        <AlarmPropertiesPanel
          config={config}
          selection={selection}
          onPatchGroup={patchGroup}
          onPatchAlarm={patchAlarm}
        />
      }
    />
  );
}
