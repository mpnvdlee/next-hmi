import type {
  AlarmConfig,
  AlarmGroup,
  AlarmDefinition,
  AlarmLevel,
  AlarmTriggerType,
} from '@shared/types/alarm';
import type { AlarmSelection } from '@config/store/alarmConfigStore';
import type { VariableBinding } from '@shared/types/config';
import type { OpenBindingPicker } from '../../editor/PropertySourceEditor';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import PanelHeader from '../../ui/PanelHeader';
import PropRow from '../../ui/PropRow';
import GroupsField from '../../ui/GroupsField';
import TextField from '../../ui/TextField';
import Select from '../../ui/Select';
import AddButton from '../../ui/AddButton';
import BoolButtonGroup from '../../ui/BoolButtonGroup';
import PropertiesEmpty from '../../ui/PropertiesEmpty';
import { CollapsiblePropertyCard } from '../../editor/PropertySourceEditor/editors/shared';
import { getStaticString } from '../../editor/propertyValueUtils';
import { varBindingOf } from '../../editor/bindingPickerUtils';
import { findAlarm, resolveAlarmString } from '../alarmDisplayUtils';
import { ClearIcon } from '../../ui/actionIcons';
import type { SchemaField } from '@shared/types/widgetSchema';

const NUMERIC_DATA_TYPES = ['Integer', 'Float'];

interface Props {
  config: AlarmConfig;
  selection: AlarmSelection;
  onPatchGroup(id: string, patch: Partial<Pick<AlarmGroup, 'title'>>): void;
  onPatchAlarm(id: string, patch: Partial<AlarmDefinition>): void;
}

export default function AlarmPropertiesPanel({
  config,
  selection,
  onPatchGroup,
  onPatchAlarm,
}: Props) {
  if (!selection) {
    return <PropertiesEmpty>Select a group or alarm to view its properties.</PropertiesEmpty>;
  }

  if (selection.type === 'group') {
    const group = config.groups.find((g) => g.id === selection.id);
    if (!group) return null;
    return <GroupPanel group={group} onPatch={onPatchGroup} />;
  }

  if (selection.type === 'alarm') {
    const alarm = findAlarm(config, selection.id);
    if (!alarm) return null;
    return <AlarmPanel alarm={alarm} onPatch={onPatchAlarm} />;
  }

  return null;
}

// ── Group Panel ────────────────────────────────────────────────────────────

function GroupPanel({
  group,
  onPatch,
}: {
  group: AlarmGroup;
  onPatch(id: string, patch: Partial<Pick<AlarmGroup, 'title'>>): void;
}) {
  return (
    <div className="cfg-ds-props">
      <PanelHeader kind="alarm group" name={group.title || 'Untitled'} />

      <div className="cfg-section">
        <div className="cfg-section__title">Group</div>
        <PropRow label="Title" sourceless>
          <TextField value={group.title} onCommit={(text) => onPatch(group.id, { title: text })} />
        </PropRow>
      </div>
    </div>
  );
}

// ── Alarm Panel ────────────────────────────────────────────────────────────

function AlarmPanel({
  alarm,
  onPatch,
}: {
  alarm: AlarmDefinition;
  onPatch(id: string, patch: Partial<AlarmDefinition>): void;
}) {
  const openBindingPicker = useEditorDomainStore((s) => s.openBindingPicker);

  function updateTrigger(patch: Record<string, unknown>) {
    onPatch(alarm.id, { trigger: { ...alarm.trigger, ...patch } });
  }

  // ── Binding-picker helpers ─────────────────────────────────────────────

  function makePicker(
    scope: string,
    current: unknown,
    apply: (binding: VariableBinding) => void,
    filter: { label: string; type: string | string[] },
  ): OpenBindingPicker {
    return (onPick) => {
      openBindingPicker('', scope, {
        onPick: (binding: VariableBinding) => {
          apply(binding);
          onPick?.(binding);
        },
        filter,
        currentBinding: varBindingOf(current),
      });
    };
  }

  const openImagePicker = makePicker(
    'alarm-image',
    alarm.image,
    (binding) => onPatch(alarm.id, { image: { $var: binding } }),
    { label: 'Image filename variable', type: 'String' },
  );

  const openSourcePicker = makePicker(
    'alarm-source',
    alarm.trigger.source_value,
    (binding) => updateTrigger({ source_value: { $var: binding } }),
    {
      label: 'Alarm trigger variable',
      type: alarm.trigger.type === 'bool' ? 'Boolean' : NUMERIC_DATA_TYPES,
    },
  );

  const openMinPicker = makePicker(
    'alarm-min',
    alarm.trigger.min,
    (binding) => updateTrigger({ min: { $var: binding } }),
    { label: 'Min threshold', type: NUMERIC_DATA_TYPES },
  );

  const openMaxPicker = makePicker(
    'alarm-max',
    alarm.trigger.max,
    (binding) => updateTrigger({ max: { $var: binding } }),
    { label: 'Max threshold', type: NUMERIC_DATA_TYPES },
  );

  function addResolution() {
    onPatch(alarm.id, { resolutions: [...alarm.resolutions, ''] });
  }

  function updateResolution(index: number, value: unknown) {
    const next = [...alarm.resolutions];
    next[index] = value;
    onPatch(alarm.id, { resolutions: next });
  }

  function removeResolution(index: number) {
    onPatch(alarm.id, { resolutions: alarm.resolutions.filter((_, i) => i !== index) });
  }

  return (
    <div className="cfg-ds-props">
      <PanelHeader kind="alarm" name={resolveAlarmString(alarm.title) || 'Untitled'} />

      {/* ── General ── */}
      <div className="cfg-section">
        <div className="cfg-section__title">General</div>

        <PropRow label="Code" sourceless>
          <TextField value={alarm.code} onCommit={(text) => onPatch(alarm.id, { code: text })} />
        </PropRow>

        <PropRow label="Level" tier={2}>
          <Select
            value={alarm.level}
            onChange={(v) => onPatch(alarm.id, { level: v as AlarmLevel })}
          >
            <option value="error">Error</option>
            <option value="warning">Warning</option>
            <option value="info">Info</option>
          </Select>
        </PropRow>

        <CollapsiblePropertyCard
          title="Title"
          value={alarm.title}
          schema={{ type: 'String', label: 'Title' } as SchemaField}
          forcedSources={['static', '$loc']}
          onChange={(v) => onPatch(alarm.id, { title: v })}
          staticEditor={
            <TextField
              value={getStaticString(alarm.title)}
              onCommit={(text) => onPatch(alarm.id, { title: text })}
            />
          }
        />

        <CollapsiblePropertyCard
          title="Description"
          value={alarm.description}
          schema={{ type: 'String', label: 'Description' } as SchemaField}
          forcedSources={['static', '$loc', '$stringExpr']}
          onChange={(v) => onPatch(alarm.id, { description: v })}
          staticEditor={
            <TextField
              rows={3}
              value={getStaticString(alarm.description)}
              onCommit={(text) => onPatch(alarm.id, { description: text })}
            />
          }
        />

        <CollapsiblePropertyCard
          title="Image"
          value={alarm.image}
          schema={{ type: 'image', label: 'Image' } as SchemaField}
          forcedSources={['static', '$var']}
          onChange={(v) => onPatch(alarm.id, { image: v })}
          onOpenBindingPicker={openImagePicker}
          staticEditor={
            <TextField
              placeholder="filename in assets/images/"
              value={getStaticString(alarm.image)}
              onCommit={(text) =>
                onPatch(alarm.id, { image: text === '' ? '' : { $static: text } })
              }
            />
          }
        />

        <PropRow
          label="Auto popup"
          description="Raises the alarm popup on every display as soon as this alarm becomes active."
        >
          <BoolButtonGroup
            value={alarm.auto_popup}
            onChange={(v) => onPatch(alarm.id, { auto_popup: v })}
            labels={['On', 'Off']}
          />
        </PropRow>
      </div>

      {/* ── Trigger ── */}
      <div className="cfg-section">
        <div className="cfg-section__title">Trigger</div>

        <PropRow label="Type" tier={2}>
          <Select
            value={alarm.trigger.type}
            onChange={(v) => updateTrigger({ type: v as AlarmTriggerType })}
          >
            <option value="bool">Boolean</option>
            <option value="value_range">Value Range</option>
          </Select>
        </PropRow>

        <CollapsiblePropertyCard
          title="Source"
          value={alarm.trigger.source_value}
          schema={
            {
              type: alarm.trigger.type === 'bool' ? 'boolean' : 'float',
              label: 'Source',
            } as SchemaField
          }
          forcedSources={['static', '$var']}
          onChange={(v) => updateTrigger({ source_value: v })}
          onOpenBindingPicker={openSourcePicker}
          staticEditor={
            alarm.trigger.type === 'bool' ? (
              <BoolButtonGroup
                value={getStaticString(alarm.trigger.source_value, 'true') === 'true'}
                onChange={(v) => updateTrigger({ source_value: { $static: v } })}
                labels={['True', 'False']}
              />
            ) : (
              <TextField
                type="number"
                value={getStaticString(alarm.trigger.source_value)}
                onCommit={(text) =>
                  updateTrigger({
                    source_value: text === '' ? null : { $static: Number(text) },
                  })
                }
              />
            )
          }
        />

        {alarm.trigger.type === 'bool' && (
          <PropRow label="Trigger on" description="Which state of the source raises this alarm.">
            <BoolButtonGroup
              value={alarm.trigger.on_true}
              onChange={(v) => updateTrigger({ on_true: v })}
              labels={['True', 'False']}
            />
          </PropRow>
        )}

        {alarm.trigger.type === 'value_range' && (
          <>
            <CollapsiblePropertyCard
              title="Min"
              value={alarm.trigger.min}
              schema={{ type: 'Float', label: 'Min' } as SchemaField}
              forcedSources={['static', '$var']}
              onChange={(v) => updateTrigger({ min: v })}
              onOpenBindingPicker={openMinPicker}
              staticEditor={
                <TextField
                  type="number"
                  value={getStaticString(alarm.trigger.min)}
                  onCommit={(text) =>
                    updateTrigger({ min: text === '' ? null : { $static: Number(text) } })
                  }
                />
              }
            />

            <CollapsiblePropertyCard
              title="Max"
              value={alarm.trigger.max}
              schema={{ type: 'Float', label: 'Max' } as SchemaField}
              forcedSources={['static', '$var']}
              onChange={(v) => updateTrigger({ max: v })}
              onOpenBindingPicker={openMaxPicker}
              staticEditor={
                <TextField
                  type="number"
                  value={getStaticString(alarm.trigger.max)}
                  onCommit={(text) =>
                    updateTrigger({ max: text === '' ? null : { $static: Number(text) } })
                  }
                />
              }
            />
          </>
        )}
      </div>

      {/* ── Resolutions ──
          Same shape as a widget's action list and the Global Events panel: the
          add control sits behind the title, and each entry is one uniform row —
          the `#N` heading above every row stacked up and named nothing the row
          didn't already show. */}
      <div className="cfg-section">
        <div className="cfg-editor-actions cfg-alarm-resolutions">
          <div className="cfg-editor-actions__title-row">
            <div className="cfg-section__title">Resolutions</div>
            <AddButton title="Add resolution" onClick={addResolution} />
          </div>

          {alarm.resolutions.map((r, i) => (
            <CollapsiblePropertyCard
              key={i}
              title={`#${i + 1}`}
              hideLabel
              value={r}
              schema={{ type: 'String', label: `#${i + 1}` } as SchemaField}
              forcedSources={['static', '$loc', '$stringExpr']}
              onChange={(v) => updateResolution(i, v)}
              actions={
                <button
                  type="button"
                  className="cfg-row-action-btn cfg-row-action-btn--stretch"
                  title="Remove resolution"
                  onClick={() => removeResolution(i)}
                >
                  <ClearIcon />
                </button>
              }
              staticEditor={
                <TextField
                  rows={3}
                  value={getStaticString(r)}
                  onCommit={(text) => updateResolution(i, text)}
                />
              }
            />
          ))}

          {alarm.resolutions.length === 0 && (
            <span className="cfg-prop-hint cfg-section__empty">No resolutions yet</span>
          )}
        </div>
      </div>

      {/* ── Ack Permissions ── */}
      <div className="cfg-section">
        <div className="cfg-section__title">Acknowledgment Permissions</div>
        <GroupsField
          label="Allowed groups"
          description="Empty → any user may acknowledge."
          value={alarm.ack_groups}
          onChange={(v) =>
            onPatch(alarm.id, { ack_groups: Array.isArray(v) ? (v as string[]) : [] })
          }
        />
      </div>
    </div>
  );
}
