import { useContext, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import type { BindingPickMetadata } from '@config/store/domains/editorDomainStore';
import {
  getWriteCoercionKind,
  loadVariableWriteDescriptor,
  type VariableWriteDescriptor,
  writeDescriptorNeedsRefresh,
} from '@config/utils/variableType';
import { useConfigStore } from '@shared/store/configStore';
import { flattenPages, resolvePageTitle } from '@shared/utils/pageTree';
import type {
  ActionsConfig,
  ButtonAction,
  DialogConfig,
  PageConfig,
  VariableBinding,
} from '@shared/types/config';
import { bindingParts } from '@shared/types/config';
import type { SchemaField } from '@shared/types/widgetSchema';
import Select from '@config/components/ui/Select';
import { ClearIcon } from '@config/components/ui/actionIcons';
import FieldGroup from '@config/components/ui/FieldGroup';
import { PanelScopeContext, usePanelExpansionStore } from '@config/store/panelExpansionStore';
import { useFieldDiagnostic } from '@config/hooks/usePanelDiagnostics';
import { BreakableToken, Kw, KindLabel, PreviewText } from '../PropertySourceEditor/editors/shared';
import { propertyValuePreview } from '../propertyValueUtils';
import { ActionTypeBadge } from './actionTypeIcons';
import { ACTION_TYPES, ACTION_TYPE_TINT, actionTypeLabel } from './actionsPreview';
import { getDefaultValueForKind, makeDefaultAction } from './actionMutations';
import { ACTION_EDITORS, type ActionEditorCtx } from './actionEditors';

interface Props {
  value: ActionsConfig | undefined;
  onChange: (v: unknown) => void;
  eventKey?: string;
  eventLabel?: string;
  hideHeader?: boolean;
  /** When set, renders the field title and the "+ Add action" control together
   *  on one header row (add button sits behind the title), and drops the
   *  trailing add control at the bottom of the list. */
  headerTitle?: string;
  /** Explanatory copy under the header title — the action list has no
   *  `FieldGroup` of its own to carry a `description`, so it renders it here. */
  description?: string;
  /** Selection-path prefix to this event's action list (e.g. `['actions']` from
   *  a top-level `actions` property, or `[...parentActionPath]` from a nested
   *  result handler). Used to build per-action copy/paste selection paths. */
  pathPrefix?: string[];
  /** Fields the backend populates on the result payload for the enclosing async
   *  action's slot — set when these actions render inside onSuccess/onFailed/
   *  onSettled. When present, descendant editors expose `$result` and limit
   *  its field dropdown to this list. */
  resultFields?: string[];
}

export default function ActionsInput({
  value,
  onChange,
  eventKey = 'onPress',
  eventLabel = 'On Pressed',
  hideHeader,
  headerTitle,
  description,
  pathPrefix,
  resultFields,
}: Props) {
  const pages = useConfigStore((s) => s.pages);
  const dialogs = useConfigStore((s) => s.dialogs);
  const allPages = flattenPages(pages);
  const openBindingPicker = useEditorDomainStore((s) => s.openBindingPicker);
  const actions =
    (value as Record<string, ButtonAction[] | undefined> | undefined)?.[eventKey] ?? [];
  const [dataTypes, setDataTypes] = useState<Record<string, VariableWriteDescriptor>>({});
  const scope = useContext(PanelScopeContext);
  const setPanelExpanded = usePanelExpansionStore((s) => s.setExpanded);

  function update(newActions: ButtonAction[]) {
    onChange({ ...(value ?? {}), [eventKey]: newActions });
  }

  function addAction(type: string) {
    const next = makeDefaultAction(type, { dialogs, allPages });
    if (!next) return;
    const idx = actions.length;
    update([...actions, next]);
    // Existing actions load collapsed; the one the user just added opens so
    // they can edit it immediately (its FieldGroup reads this session key).
    const path = [...(pathPrefix ?? []), eventKey, String(idx)];
    setPanelExpanded(`${scope}::${path.join('/')}`, true);
  }

  function removeAction(idx: number) {
    update(actions.filter((_, i) => i !== idx));
  }

  function updateAction(idx: number, patch: Partial<ButtonAction>) {
    update(actions.map((a, i) => (i === idx ? ({ ...a, ...patch } as ButtonAction) : a)));
  }

  useEffect(() => {
    let cancelled = false;

    async function ensureDataTypes() {
      for (const action of actions) {
        if (action.type !== 'writeDataVariable') continue;
        if (!action.datasource || !action.path) continue;

        const key = `${action.datasource}:${action.path}`;
        if (!writeDescriptorNeedsRefresh(dataTypes[key])) continue;

        const descriptor = await loadVariableWriteDescriptor(action.datasource, action.path);
        if (cancelled || !descriptor) continue;
        setDataTypes((prev) => ({ ...prev, [key]: descriptor }));
      }
    }

    void ensureDataTypes();
    return () => {
      cancelled = true;
    };
    // dataTypes is intentionally excluded — the effect updates it via setDataTypes
    // and re-reads happen as actions change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions]);

  function openWriteVarPicker(actionIdx: number) {
    const current = actions[actionIdx];
    // The write target is stored as a flat datasource/path pair (index already
    // baked into `path` as a `[N]` suffix), which is exactly the picker's key.
    const currentBinding =
      current?.type === 'writeDataVariable' && current.datasource && current.path
        ? { path: `${current.datasource}:${current.path}` }
        : undefined;
    openBindingPicker('', 'writeDataVariable', {
      currentBinding,
      onPick: (binding: VariableBinding, metadata?: BindingPickMetadata) => {
        const action = actions[actionIdx];
        if (action && action.type === 'writeDataVariable') {
          const dataType = metadata?.dataType;
          const kind = getWriteCoercionKind(dataType);
          const { datasource, location } = bindingParts(binding);
          const targetPath =
            metadata?.index !== undefined ? `${location}[${metadata.index}]` : location;
          // Confirming the target the action already writes must not reset the
          // authored value — the picker now opens preselected, so a plain
          // Confirm is a no-op the user expects to change nothing.
          const retargeted = action.datasource !== datasource || action.path !== targetPath;
          updateAction(actionIdx, {
            datasource,
            path: targetPath,
            ...(retargeted && {
              value:
                metadata?.isArray && metadata.index === undefined
                  ? []
                  : getDefaultValueForKind(kind),
            }),
          });
          if (dataType) {
            const key = `${datasource}:${targetPath}`;
            setDataTypes((prev) => ({
              ...prev,
              [key]: {
                dataType,
                isArray: metadata?.isArray === true,
                arrayLength: metadata?.arrayLength,
                ...(metadata?.index !== undefined && {
                  indexed: true,
                  arrayIndex: metadata.index,
                }),
                complete: false,
              },
            }));
          }
        }
      },
      filter: {
        label: 'Write Data Variable target',
        write: true,
        type: ['String', 'Boolean', 'Integer', 'Float', 'DateTime', 'Date', 'Time', 'Duration'],
      },
    });
  }

  const effectivePathPrefix = pathPrefix ?? [];

  const addControl = (
    <Select
      className="cfg-editor-actions__add"
      value=""
      onChange={(v) => {
        if (v) addAction(v);
      }}
    >
      <option value="">Add</option>
      {ACTION_TYPES.map((t) => (
        <option key={t.type} value={t.type}>
          {t.label}
        </option>
      ))}
    </Select>
  );

  return (
    <div className="cfg-editor-actions">
      {headerTitle !== undefined ? (
        <div className="cfg-editor-actions__title-row">
          <span className="cfg-field-group__label">{headerTitle}</span>
          {addControl}
        </div>
      ) : (
        !hideHeader && <div className="cfg-editor-actions__header">{eventLabel}</div>
      )}
      {description && <p className="cfg-field-group__desc">{description}</p>}
      {actions.map((action, idx) => (
        <ActionRow
          key={idx}
          action={action}
          idx={idx}
          pathPrefix={effectivePathPrefix}
          eventKey={eventKey}
          dialogs={dialogs}
          allPages={allPages}
          dataTypes={dataTypes}
          openBindingPicker={openBindingPicker}
          onUpdate={(patch) => updateAction(idx, patch)}
          onRemove={() => removeAction(idx)}
          onOpenWriteVarPicker={() => openWriteVarPicker(idx)}
          resultFields={resultFields}
        />
      ))}
      {headerTitle === undefined && addControl}
    </div>
  );
}

/** One-line collapsed summary per action type — shown when the row's
 *  tier-3 FieldGroup is collapsed, same role as CollapsedPreview for
 *  expression fields. */
function actionSummaryText(
  action: ButtonAction,
  dialogs: DialogConfig[],
  allPages: PageConfig[],
): ReactNode {
  const tint = ACTION_TYPE_TINT[action.type];
  // Keyword renders in the action's tint; a named value (dialog title, dataset
  // id, username, …) is user data, not a keyword, so it stays plain — same
  // split property previews make between structural words and interpolated
  // values (see previewNodes).
  const K = (keyword: string, value?: ReactNode, suffix?: string) => (
    <>
      <Kw tint={tint}>{keyword}</Kw>
      {value != null && <> “{value}”</>}
      {suffix && <Kw tint={tint}>{suffix}</Kw>}
    </>
  );
  switch (action.type) {
    case 'openDialog': {
      const d = dialogs.find((x) => x.id === action.dialogId);
      return d ? K('Open', d.title) : K('Open dialog');
    }
    case 'closeDialog': {
      const d = dialogs.find((x) => x.id === action.dialogId);
      return d ? K('Close', d.title) : K('Close top-most dialog');
    }
    case 'openPageOverlay': {
      const p = allPages.find((x) => x.id === action.pageId);
      return p ? K('Open', resolvePageTitle(p.title), ' overlay') : K('Open page overlay');
    }
    case 'closePageOverlay': {
      const p = allPages.find((x) => x.id === action.pageId);
      return p ? K('Close', resolvePageTitle(p.title), ' overlay') : K('Close top-most overlay');
    }
    case 'writeDataVariable':
      return action.datasource && action.path ? (
        // NBSP, not a plain space: a normal space is a wrap opportunity, so a
        // path too long to follow the keyword moves down whole and strands
        // "Write" alone on the first line. Glued, the keyword keeps the start
        // of the path and `breakableToken` decides where the rest wraps.
        <>
          <Kw tint={tint}>Write</Kw>
          {'\u00a0'}
          <BreakableToken text={`${action.datasource}:${action.path}`} />
        </>
      ) : (
        K('Write data variable')
      );
    case 'recipeLoad': {
      const dataset = propertyValuePreview(action.datasetId, 'string');
      return dataset !== '—' ? K('Load recipe', dataset) : K('Load recipe');
    }
    case 'recipeSave': {
      const dataset = propertyValuePreview(action.datasetId, 'string');
      return dataset !== '—' ? K('Save recipe', dataset) : K('Save recipe');
    }
    case 'loginUser': {
      const username = propertyValuePreview(action.username, 'string');
      return username !== '—' ? K('Log in', username) : K('Log in user');
    }
    case 'logoutUser':
      return K('Log out user');
    case 'setLanguage': {
      const lang = propertyValuePreview(action.language, 'string');
      return lang !== '—' ? (
        <>
          <Kw tint={tint}>Set language</Kw> {lang}
        </>
      ) : (
        K('Set language')
      );
    }
    case 'setActiveTheme': {
      const theme = propertyValuePreview(action.theme, 'string');
      return theme !== '—' ? K('Set theme', theme) : K('Set theme');
    }
    case 'showAlert': {
      const title = propertyValuePreview(action.title, 'string');
      return title !== '—' ? K('Show alert', title) : K('Show alert');
    }
    case 'showToast':
      return (
        <>
          <Kw tint={tint}>Show toast</Kw> ({action.severity ?? 'info'})
        </>
      );
  }
}

function ActionRow({
  action,
  idx,
  pathPrefix,
  eventKey,
  dialogs,
  allPages,
  dataTypes,
  openBindingPicker,
  onUpdate,
  onRemove,
  onOpenWriteVarPicker,
  resultFields,
}: {
  action: ButtonAction;
  idx: number;
  pathPrefix: string[];
  eventKey: string;
  dialogs: DialogConfig[];
  allPages: PageConfig[];
  dataTypes: Record<string, VariableWriteDescriptor>;
  openBindingPicker: ActionEditorCtx['openBindingPicker'];
  onUpdate: (patch: Partial<ButtonAction>) => void;
  onRemove: () => void;
  onOpenWriteVarPicker: () => void;
  resultFields?: string[];
}) {
  const path = [...pathPrefix, eventKey, String(idx)];
  const actionLabel = actionTypeLabel(action.type);
  const actionSchema: SchemaField = { type: '_action', label: actionLabel };
  // Anything the backend flags inside this action (an unresolvable write
  // target, a bad nested binding) marks the collapsed row too — otherwise the
  // only clue lives behind an expand click.
  const widgetId = useContext(PanelScopeContext);
  const diagnostic = useFieldDiagnostic(widgetId, path);

  const Editor = ACTION_EDITORS[action.type] as
    ComponentType<{ action: ButtonAction; ctx: ActionEditorCtx }> | undefined;

  const ctx: ActionEditorCtx = {
    update: onUpdate,
    dialogs,
    allPages,
    dataTypes,
    openBindingPicker,
    openWriteVarPicker: onOpenWriteVarPicker,
    ActionsInput,
    path,
    resultFields,
  };

  return (
    <FieldGroup
      tier={3}
      selection={{ path, schema: actionSchema }}
      diagnostic={diagnostic}
      drawerTitle={actionLabel}
      badge={<ActionTypeBadge type={action.type} />}
      kindLabel={<KindLabel>{actionLabel}</KindLabel>}
      summary={<PreviewText>{actionSummaryText(action, dialogs, allPages)}</PreviewText>}
      actions={
        <button
          className="cfg-row-action-btn cfg-row-action-btn--stretch"
          type="button"
          title="Remove action"
          onClick={onRemove}
        >
          <ClearIcon />
        </button>
      }
    >
      {Editor && <Editor action={action} ctx={ctx} />}
    </FieldGroup>
  );
}
