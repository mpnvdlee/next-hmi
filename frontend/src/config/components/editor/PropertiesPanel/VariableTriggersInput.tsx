import '../VariableListInput/style.css';
import { useContext } from 'react';
import type { BindingPickMetadata } from '@config/store/domains/editorDomainStore';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { PanelScopeContext } from '@config/store/panelExpansionStore';
import { useFieldDiagnostic } from '@config/hooks/usePanelDiagnostics';
import type {
  ActionsConfig,
  ButtonAction,
  VariableBinding,
  VariableTrigger,
} from '@shared/types/config';
import AddButton from '@config/components/ui/AddButton';
import FieldGroup from '@config/components/ui/FieldGroup';
import PropertySourceBadge from '@config/components/editor/PropertySourceSelector/PropertySourceBadge';
import { ClearIcon, EditIcon } from '@config/components/ui/actionIcons';
import { KindLabel, PreviewText } from '../PropertySourceEditor/editors/shared';
import ActionsInput from './ActionsInput';

interface Props {
  value: VariableTrigger[] | undefined;
  onChange: (v: VariableTrigger[]) => void;
}

function bindingLabel(binding: VariableBinding | undefined): string {
  if (!binding) return '';
  return binding.index !== undefined ? `${binding.path}[${String(binding.index)}]` : binding.path;
}

/**
 * The Global Events `onVariableChanged` list: each entry names one variable
 * and the actions to run when its value changes. Each trigger is a
 * collapsible row like an action, headed by its variable, holding the
 * variable picker and the trigger's own action list.
 */
export default function VariableTriggersInput({ value = [], onChange }: Props) {
  const openBindingPicker = useEditorDomainStore((s) => s.openBindingPicker);

  // `base` is the list the picker was opened against — the one `addTrigger`
  // just built, which is not yet the `value` this render closed over.
  function pickInto(idx: number, base: VariableTrigger[] = value) {
    openBindingPicker('', 'variableTrigger', {
      currentBinding: base[idx]?.variable?.$var,
      onPick: (binding: VariableBinding, metadata?: BindingPickMetadata) => {
        const picked =
          metadata?.index !== undefined ? { ...binding, index: metadata.index } : binding;
        onChange(base.map((t, i) => (i === idx ? { ...t, variable: { $var: picked } } : t)));
      },
      filter: { label: 'Variable' },
    });
  }

  function addTrigger() {
    const next = [...value, { actions: [] }];
    onChange(next);
    pickInto(next.length - 1, next);
  }

  return (
    <div className="cfg-editor-actions">
      <div className="cfg-editor-actions__title-row">
        <span className="cfg-field-group__label">Variable Changed</span>
        <AddButton title="Add variable trigger" onClick={addTrigger} />
      </div>
      <p className="cfg-field-group__desc">
        Runs the actions when the variable&apos;s value changes, and once at start-up. Use an If
        to act on one value only.
      </p>
      {value.length === 0 && <div className="cfg-prop-hint">No variable triggers yet</div>}
      {value.map((trigger, idx) => (
        <TriggerRow
          key={idx}
          trigger={trigger}
          idx={idx}
          onPick={() => pickInto(idx)}
          onUpdate={(patch) =>
            onChange(value.map((t, i) => (i === idx ? { ...t, ...patch } : t)))
          }
          onRemove={() => onChange(value.filter((_, i) => i !== idx))}
        />
      ))}
    </div>
  );
}

function TriggerRow({
  trigger,
  idx,
  onPick,
  onUpdate,
  onRemove,
}: {
  trigger: VariableTrigger;
  idx: number;
  onPick: () => void;
  onUpdate: (patch: Partial<VariableTrigger>) => void;
  onRemove: () => void;
}) {
  const path = ['onVariableChanged', String(idx)];
  const diagnostic = useFieldDiagnostic(useContext(PanelScopeContext), path);
  const label = bindingLabel(trigger.variable?.$var);
  const count = trigger.actions?.length ?? 0;
  const heading = label || 'Select variable…';
  return (
    <FieldGroup
      tier={3}
      // A new trigger opens on its editors, the way a new action does.
      defaultExpanded={!trigger.variable}
      diagnostic={diagnostic}
      drawerTitle={heading}
      badge={<PropertySourceBadge source="$var" variant="cap" />}
      kindLabel={<KindLabel>{heading}</KindLabel>}
      summary={
        <PreviewText>
          {heading} · {count} {count === 1 ? 'action' : 'actions'}
        </PreviewText>
      }
      actions={
        <button
          type="button"
          className="cfg-row-action-btn cfg-row-action-btn--stretch"
          title="Remove trigger"
          onClick={onRemove}
        >
          <ClearIcon />
        </button>
      }
    >
      <FieldGroup
        label="Variable"
        tier={1}
        badge={<PropertySourceBadge source="$var" variant="cap" />}
        actions={
          <button
            type="button"
            className="cfg-row-action-btn cfg-row-action-btn--stretch"
            title="Select variable"
            onClick={onPick}
          >
            <EditIcon />
          </button>
        }
      >
        <button
          type="button"
          className="cfg-var-field cfg-var-list__pick"
          title={label || 'Select variable'}
          onClick={onPick}
        >
          <span
            className={`cfg-var-field__text cfg-var-field__path${
              label ? '' : ' cfg-var-field__text--empty'
            }`}
          >
            <bdi>{heading}</bdi>
          </span>
        </button>
      </FieldGroup>
      <ActionsInput
        value={{ actions: trigger.actions ?? [] } as ActionsConfig}
        onChange={(v) =>
          onUpdate({ actions: (v as Record<string, ButtonAction[] | undefined>).actions ?? [] })
        }
        eventKey="actions"
        eventLabel="Actions"
        headerTitle="Actions"
        pathPrefix={path}
      />
    </FieldGroup>
  );
}
