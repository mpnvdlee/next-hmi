/**
 * Per-action-type editors for ActionsInput.
 *
 * Each editor is a small component keyed by `ButtonAction.type` in
 * ACTION_EDITORS. The parent ActionsInput dispatches by `action.type`,
 * so adding a new action means: add the variant to ButtonAction, write
 * an editor here, register it in the map.
 *
 * Editors share an ActionEditorCtx for parent callbacks (update, picker
 * openers) and computed lists (dialogs, allPages).
 */

// File exports the ACTION_EDITORS registry alongside its component definitions —
// they belong together as the dispatch table.
/* eslint-disable react-refresh/only-export-components */

import { useContext, useMemo, type ComponentType, type ReactNode } from 'react';
import type {
  ButtonAction,
  DialogConfig,
  OverlayPlacement,
  OverlaySize,
  PageConfig,
  VariableBinding,
} from '@shared/types/config';
import type { SchemaField } from '@shared/types/widgetSchema';
import { getWriteCoercionKind, type VariableWriteDescriptor } from '@config/utils/variableType';
import { canonicalOpcuaWriteType, coerceOpcuaWrite } from '@shared/utils/opcuaWriteCoercion';
import { isAnchoredPlacement } from '@shared/utils/anchorPosition';
import { CollapsiblePropertyCard } from '../PropertySourceEditor/editors/shared';
import { PickerField } from '../../ui/PathInputField';
import type { OpenBindingPicker } from '../PropertySourceEditor/editors/utils';
import { ParentPathContext } from '../PropertySourceEditor/parentPathContext';
import PropRow from '../../ui/PropRow';
import Select from '../../ui/Select';
import BoolButtonGroup from '../../ui/BoolButtonGroup';
import SchemaFieldRow from '../../ui/SchemaFieldRow';
import type ActionsInputType from './ActionsInput';
import { componentPropertyToSchemaField } from '@shared/types/componentProperty';
import { resolvePageTitle } from '@shared/utils/pageTree';
import { ResultFieldsContext } from '../PropertySourceEditor/resultFieldsContext';
import { varBindingOf } from '../bindingPickerUtils';
import { PanelScopeContext } from '@config/store/panelExpansionStore';
import { useFieldDiagnostic } from '@config/hooks/usePanelDiagnostics';

// ── Shared ─────────────────────────────────────────────────────────────────

export interface ActionEditorCtx {
  /** Patch this action with the given partial. */
  update: (patch: Partial<ButtonAction>) => void;
  dialogs: DialogConfig[];
  allPages: PageConfig[];
  /** Cached `data_type` for writeDataVariable bindings, keyed by `${ds}:${path}`. */
  dataTypes: Record<string, VariableWriteDescriptor>;
  /** Generic binding picker — for loginUser/setLanguage style fields. */
  openBindingPicker: (
    componentId: string,
    propertyKey: string,
    options?: {
      onPick?: (binding: VariableBinding) => void;
      /** Binding the field holds today, so the picker opens on it. */
      currentBinding?: VariableBinding;
    },
  ) => void;
  /** Open the writeDataVariable picker; updates this action + the dataTypes cache on pick. */
  openWriteVarPicker: () => void;
  /** ActionsInput component, threaded in to break the circular import for nested editors (showAlert). */
  ActionsInput: typeof ActionsInputType;
  /** Full selection path prefix to this action (e.g. `['actions', 'onPress', '0']`).
   *  Used by per-field rows to register copy/paste selection. */
  path: string[];
  /** Names of fields the backend populates on the result payload for the enclosing
   *  async action's slot — present when this action lives inside an onSuccess /
   *  onFailed / onSettled list (possibly transitively, e.g. inside a showAlert's
   *  onOk that is itself nested in such a slot). When set, field editors expose
   *  `$result` as a source and limit its field dropdown to this list. */
  resultFields?: string[];
}

/** PropRow wrapper that wires copy/paste selection for a field inside an action. */
function ActionFieldRow({
  ctx,
  fieldKey,
  schema,
  label,
  block,
  children,
}: {
  ctx: ActionEditorCtx;
  fieldKey: string;
  schema: SchemaField;
  label: string;
  block?: boolean;
  children: ReactNode;
}) {
  return (
    <PropRow label={label} selection={{ path: [...ctx.path, fieldKey], schema }} block={block}>
      {children}
    </PropRow>
  );
}

type EditorFor<T extends ButtonAction['type']> = ComponentType<{
  action: Extract<ButtonAction, { type: T }>;
  ctx: ActionEditorCtx;
}>;

function LoginFieldEditor({
  ctx,
  fieldKey,
  label,
  value,
  onChange,
  onOpenBindingPicker,
}: {
  ctx: ActionEditorCtx;
  fieldKey: string;
  label: string;
  value: unknown;
  onChange: (v: unknown) => void;
  onOpenBindingPicker?: OpenBindingPicker;
}) {
  const inResultHandler = (ctx.resultFields?.length ?? 0) > 0;
  const schema: SchemaField = { type: 'String', label, placeholder: label };
  const card = (
    <ParentPathContext.Provider value={[...ctx.path, fieldKey]}>
      <CollapsiblePropertyCard
        title={label}
        value={value}
        onChange={onChange}
        schema={schema}
        onOpenBindingPicker={onOpenBindingPicker}
      />
    </ParentPathContext.Provider>
  );
  return inResultHandler ? (
    <ResultFieldsContext.Provider value={ctx.resultFields ?? null}>
      {card}
    </ResultFieldsContext.Provider>
  ) : (
    card
  );
}

type ResultEventKey = 'onSuccess' | 'onFailed' | 'onSettled';
type AsyncActionType =
  'loginUser' | 'logoutUser' | 'writeDataVariable' | 'recipeLoad' | 'recipeSave';

/**
 * Field names the backend populates on the result payload, per (action type, slot).
 * Mirrors `useWebSocket.ts` (user_identity / auth_error / write_response /
 * write_error) and `actionDispatcher` (timeout / disconnected synthesis).
 * onSettled receives whichever branch's payload fired, so the union is exposed.
 */
const RESULT_FIELDS_BY_ACTION_SLOT: Record<AsyncActionType, Record<ResultEventKey, string[]>> = {
  loginUser: {
    onSuccess: ['username', 'groups', 'groupLabels'],
    onFailed: ['reason'],
    onSettled: ['username', 'groups', 'groupLabels', 'reason'],
  },
  logoutUser: {
    onSuccess: ['username', 'groups', 'groupLabels'],
    onFailed: ['reason'],
    onSettled: ['username', 'groups', 'groupLabels', 'reason'],
  },
  writeDataVariable: {
    onSuccess: ['datasource', 'path'],
    onFailed: ['datasource', 'path', 'reason'],
    onSettled: ['datasource', 'path', 'reason'],
  },
  recipeLoad: {
    onSuccess: ['result', 'datasetId', 'written', 'total', 'verified', 'failures'],
    onFailed: ['reason'],
    onSettled: ['result', 'datasetId', 'written', 'total', 'verified', 'failures', 'reason'],
  },
  recipeSave: {
    onSuccess: ['datasetId'],
    onFailed: ['reason'],
    onSettled: ['datasetId', 'reason'],
  },
};

/**
 * Renders the three collapsible sub-action lists shared by every async action
 * (loginUser, logoutUser, writeDataVariable). Mirrors showAlert's onOk /
 * onCancel pattern — nested ActionsInput threaded through ctx.
 */
function ResultHandlersSubrows({
  action,
  actionType,
  ctx,
}: {
  action: { onSuccess?: ButtonAction[]; onFailed?: ButtonAction[]; onSettled?: ButtonAction[] };
  actionType: AsyncActionType;
  ctx: ActionEditorCtx;
}) {
  const NestedActions = ctx.ActionsInput;
  const SLOTS: ResultEventKey[] = ['onSuccess', 'onFailed', 'onSettled'];
  const slotFields = RESULT_FIELDS_BY_ACTION_SLOT[actionType];
  return (
    <>
      {SLOTS.map((key) => {
        const label = `On ${key.slice(2)}`;
        return (
          <NestedActions
            key={key}
            value={{ [key]: action[key] ?? [] }}
            onChange={(v) => {
              const sub = v as Record<string, unknown>;
              ctx.update({ [key]: (sub[key] ?? []) as ButtonAction[] } as Partial<ButtonAction>);
            }}
            eventKey={key}
            eventLabel={label}
            headerTitle={label}
            pathPrefix={ctx.path}
            resultFields={slotFields[key]}
          />
        );
      })}
    </>
  );
}

// ── Per-action editors ─────────────────────────────────────────────────────

const DIALOG_SCHEMA: SchemaField = { type: 'String', format: 'select', label: 'Dialog' };

const OpenDialogEditor: EditorFor<'openDialog'> = ({ action, ctx }) => {
  const dialog = ctx.dialogs.find((d) => d.id === action.dialogId);
  const componentPropFields = useMemo(() => {
    if (!dialog?.componentProperties) return [];
    return Object.entries(dialog.componentProperties).map(
      ([key, schema]) => [key, componentPropertyToSchemaField(schema)] as const,
    );
  }, [dialog?.componentProperties]);
  const componentProps = action.componentProperties ?? {};

  function patchComponentProp(key: string, value: unknown) {
    const next = { ...componentProps };
    if (value === undefined) delete next[key];
    else next[key] = value;
    ctx.update({ componentProperties: next });
  }

  return (
    <>
      <ActionFieldRow ctx={ctx} fieldKey="dialogId" schema={DIALOG_SCHEMA} label="Dialog">
        <Select value={action.dialogId} onChange={(v) => ctx.update({ dialogId: v })}>
          <option value="">— select dialog —</option>
          {ctx.dialogs.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </Select>
      </ActionFieldRow>
      <OverlayLayoutFields action={action} ctx={ctx} defaultSize="auto" />
      {componentPropFields.length > 0 && (
        <div className="cfg-section">
          <div className="cfg-section__title">Component Properties</div>
          {componentPropFields.map(([key, field]) => (
            <SchemaFieldRow
              key={key}
              schema={field}
              value={componentProps[key]}
              onChange={(v) => patchComponentProp(key, v)}
              allProperties={componentProps}
            />
          ))}
        </div>
      )}
    </>
  );
};

const CloseDialogEditor: EditorFor<'closeDialog'> = ({ action, ctx }) => {
  return (
    <ActionFieldRow ctx={ctx} fieldKey="dialogId" schema={DIALOG_SCHEMA} label="Dialog">
      <Select
        value={action.dialogId ?? ''}
        onChange={(v) => ctx.update({ dialogId: v || undefined })}
      >
        <option value="">Top-most dialog</option>
        {ctx.dialogs.map((dialog) => (
          <option key={dialog.id} value={dialog.id}>
            {dialog.title}
          </option>
        ))}
      </Select>
    </ActionFieldRow>
  );
};

const PAGE_SCHEMA: SchemaField = { type: 'String', format: 'select', label: 'Page' };
const SIZE_SCHEMA: SchemaField = { type: 'String', format: 'select', label: 'Size' };
const PLACEMENT_SCHEMA: SchemaField = { type: 'String', format: 'select', label: 'Placement' };
const BACKDROP_SCHEMA: SchemaField = { type: 'Boolean', label: 'Dim background' };
const WIDTH_SCHEMA: SchemaField = { type: 'Integer', label: 'Width' };
const HEIGHT_SCHEMA: SchemaField = { type: 'Integer', label: 'Height' };

function renderPlacementOptions(): ReactNode {
  return (
    <>
      <optgroup label="Viewport">
        <option value="center">Center</option>
        <option value="top">Top</option>
        <option value="bottom">Bottom</option>
        <option value="left">Left</option>
        <option value="right">Right</option>
      </optgroup>
      <optgroup label="Relative to trigger">
        <option value="trigger-above">Above trigger</option>
        <option value="trigger-below">Below trigger</option>
        <option value="trigger-left">Left of trigger</option>
        <option value="trigger-right">Right of trigger</option>
      </optgroup>
    </>
  );
}

/** `anchored` hides Fullscreen, which is meaningless for a trigger-relative popover. */
function renderSizeOptions(anchored: boolean): ReactNode {
  return (
    <>
      <option value="auto">Auto (fits content)</option>
      <option value="small">Small</option>
      <option value="medium">Medium</option>
      {!anchored && <option value="fullscreen">Fullscreen</option>}
      <option value="fixed">Fixed</option>
    </>
  );
}

/** Checkbox row for the shared `backdrop: 'dim' | 'none'` field. */
function BackdropField({
  backdrop,
  ctx,
}: {
  backdrop: 'dim' | 'none' | undefined;
  ctx: ActionEditorCtx;
}) {
  const dim = (backdrop ?? 'dim') === 'dim';
  return (
    <ActionFieldRow ctx={ctx} fieldKey="backdrop" schema={BACKDROP_SCHEMA} label="Dim background">
      <BoolButtonGroup
        value={dim}
        onChange={(v) => ctx.update({ backdrop: v ? undefined : 'none' })}
      />
    </ActionFieldRow>
  );
}

type OverlayAction = Extract<ButtonAction, { type: 'openDialog' } | { type: 'openPageOverlay' }>;

/** Shared placement and sizing fields for dialog and page-overlay actions. */
function OverlayLayoutFields({
  action,
  ctx,
  defaultSize,
}: {
  action: OverlayAction;
  ctx: ActionEditorCtx;
  defaultSize: OverlaySize;
}) {
  const size = action.size ?? defaultSize;
  const anchored = isAnchoredPlacement(action.placement);
  return (
    <>
      <ActionFieldRow ctx={ctx} fieldKey="size" schema={SIZE_SCHEMA} label="Size">
        <Select
          value={size}
          onChange={(v) => {
            const next = v as OverlaySize;
            const patch: Partial<ButtonAction> = { size: next };
            if (next !== 'fixed') {
              patch.width = undefined;
              patch.height = undefined;
            }
            ctx.update(patch);
          }}
        >
          {renderSizeOptions(anchored)}
        </Select>
      </ActionFieldRow>
      <ActionFieldRow ctx={ctx} fieldKey="placement" schema={PLACEMENT_SCHEMA} label="Placement">
        <Select
          value={action.placement ?? 'center'}
          onChange={(v) => {
            const next = v as OverlayPlacement;
            // Fullscreen is meaningless when anchored to a trigger.
            ctx.update(
              isAnchoredPlacement(next) && size === 'fullscreen'
                ? { placement: next, size: defaultSize }
                : { placement: next },
            );
          }}
        >
          {renderPlacementOptions()}
        </Select>
      </ActionFieldRow>
      <BackdropField backdrop={action.backdrop} ctx={ctx} />
      {size === 'fixed' && (
        <>
          <ActionFieldRow ctx={ctx} fieldKey="width" schema={WIDTH_SCHEMA} label="Width (px)">
            <input
              type="number"
              className="cfg-prop-input"
              placeholder="400"
              value={action.width ?? 400}
              min={100}
              onChange={(e) =>
                ctx.update({ width: e.target.value === '' ? undefined : Number(e.target.value) })
              }
            />
          </ActionFieldRow>
          <ActionFieldRow ctx={ctx} fieldKey="height" schema={HEIGHT_SCHEMA} label="Height (px)">
            <input
              type="number"
              className="cfg-prop-input"
              placeholder="300"
              value={action.height ?? 300}
              min={100}
              onChange={(e) =>
                ctx.update({ height: e.target.value === '' ? undefined : Number(e.target.value) })
              }
            />
          </ActionFieldRow>
        </>
      )}
    </>
  );
}

const OpenPageOverlayEditor: EditorFor<'openPageOverlay'> = ({ action, ctx }) => {
  return (
    <>
      <ActionFieldRow ctx={ctx} fieldKey="pageId" schema={PAGE_SCHEMA} label="Page">
        <Select value={action.pageId} onChange={(v) => ctx.update({ pageId: v })}>
          <option value="">— select page —</option>
          {ctx.allPages.map((page) => (
            <option key={page.id} value={page.id}>
              {resolvePageTitle(page.title)}
            </option>
          ))}
        </Select>
      </ActionFieldRow>
      <OverlayLayoutFields action={action} ctx={ctx} defaultSize="medium" />
    </>
  );
};

const ClosePageOverlayEditor: EditorFor<'closePageOverlay'> = ({ action, ctx }) => {
  return (
    <ActionFieldRow ctx={ctx} fieldKey="pageId" schema={PAGE_SCHEMA} label="Page">
      <Select value={action.pageId ?? ''} onChange={(v) => ctx.update({ pageId: v || undefined })}>
        <option value="">Top-most overlay page</option>
        {ctx.allPages.map((page) => (
          <option key={page.id} value={page.id}>
            {resolvePageTitle(page.title)}
          </option>
        ))}
      </Select>
    </ActionFieldRow>
  );
};

const WriteDataVariableEditor: EditorFor<'writeDataVariable'> = ({ action, ctx }) => {
  // The backend anchors write-target diagnostics (unknown datasource/variable,
  // test-server target) on the action's `datasource` slot — see
  // `_validate_write_target` in core/validation/structure.py.
  const widgetId = useContext(PanelScopeContext);
  const targetDiagnostic = useFieldDiagnostic(widgetId, [...ctx.path, 'datasource']);
  const key = `${action.datasource}:${action.path}`;
  const descriptor = ctx.dataTypes[key];
  const valueKind = getWriteCoercionKind(descriptor?.dataType);
  const canonicalType = canonicalOpcuaWriteType(descriptor?.dataType);
  const validation = descriptor
    ? coerceOpcuaWrite(action.value, {
        dataType: descriptor.dataType,
        isArray: descriptor.isArray,
        arrayLength: descriptor.arrayLength,
        indexed: descriptor.indexed,
        arrayIndex: descriptor.arrayIndex,
        min: descriptor.min,
        max: descriptor.max,
      })
    : null;
  const valueSchema: SchemaField = {
    type: valueKind === 'boolean' ? 'boolean' : valueKind === 'number' ? 'number' : 'string',
    label: 'Value',
  };
  return (
    <>
      <PropRow label="Variable" diagnostic={targetDiagnostic}>
        <PickerField
          mono
          displayText={
            action.datasource && action.path ? `${action.datasource}:${action.path}` : ''
          }
          emptyLabel="Not bound"
          pickTitle="Change variable binding"
          onPick={ctx.openWriteVarPicker}
        />
      </PropRow>

      <PropRow
        label="Value"
        selection={{ path: [...ctx.path, 'value'], schema: valueSchema }}
        block={descriptor?.isArray && !descriptor.indexed}
        diagnostic={
          validation?.ok === false ? { level: 'error', message: validation.reason } : undefined
        }
      >
        {descriptor?.isArray && !descriptor.indexed ? (
          <textarea
            className="cfg-prop-input"
            placeholder="JSON array"
            value={typeof action.value === 'string' ? action.value : JSON.stringify(action.value)}
            onChange={(event) => {
              try {
                const parsed: unknown = JSON.parse(event.target.value);
                ctx.update({ value: Array.isArray(parsed) ? parsed : event.target.value });
              } catch {
                ctx.update({ value: event.target.value });
              }
            }}
          />
        ) : valueKind === 'boolean' ? (
          <BoolButtonGroup
            value={action.value === true}
            onChange={(v) => ctx.update({ value: v })}
            labels={['True', 'False']}
          />
        ) : valueKind === 'number' && canonicalType !== 'Integer' ? (
          <input
            type="number"
            className="cfg-prop-input"
            placeholder="Value"
            value={typeof action.value === 'number' ? action.value : 0}
            onChange={(e) =>
              ctx.update({ value: e.target.value === '' ? 0 : Number(e.target.value) })
            }
          />
        ) : (
          <input
            type="text"
            className="cfg-prop-input"
            placeholder="Value"
            value={String(action.value)}
            onChange={(e) => ctx.update({ value: e.target.value })}
          />
        )}
        {validation?.ok === false && (
          <span className="cfg-ds-props__error" role="alert">
            {validation.reason}
          </span>
        )}
      </PropRow>
      <ResultHandlersSubrows action={action} actionType="writeDataVariable" ctx={ctx} />
    </>
  );
};

const LoginUserEditor: EditorFor<'loginUser'> = ({ action, ctx }) => (
  <>
    <LoginFieldEditor
      ctx={ctx}
      fieldKey="username"
      label="Username"
      value={action.username}
      onChange={(v) => ctx.update({ username: v })}
      onOpenBindingPicker={(onPick, currentBinding) =>
        ctx.openBindingPicker('', 'loginUser-username', {
          currentBinding: currentBinding ?? varBindingOf(action.username),
          onPick: (binding) => {
            ctx.update({ username: { $var: binding } });
            if (onPick) onPick(binding);
          },
        })
      }
    />
    <LoginFieldEditor
      ctx={ctx}
      fieldKey="password"
      label="Password"
      value={action.password}
      onChange={(v) => ctx.update({ password: v })}
      onOpenBindingPicker={(onPick, currentBinding) =>
        ctx.openBindingPicker('', 'loginUser-password', {
          currentBinding: currentBinding ?? varBindingOf(action.password),
          onPick: (binding) => {
            ctx.update({ password: { $var: binding } });
            if (onPick) onPick(binding);
          },
        })
      }
    />
    <ResultHandlersSubrows action={action} actionType="loginUser" ctx={ctx} />
  </>
);

const LogoutUserEditor: EditorFor<'logoutUser'> = ({ action, ctx }) => (
  <ResultHandlersSubrows action={action} actionType="logoutUser" ctx={ctx} />
);

const SetLanguageEditor: EditorFor<'setLanguage'> = ({ action, ctx }) => (
  <LoginFieldEditor
    ctx={ctx}
    fieldKey="language"
    label="Language"
    value={action.language}
    onChange={(v) => ctx.update({ language: v })}
    onOpenBindingPicker={(onPick, currentBinding) =>
      ctx.openBindingPicker('', 'setLanguage-language', {
        currentBinding: currentBinding ?? varBindingOf(action.language),
        onPick: (binding) => {
          ctx.update({ language: { $var: binding } });
          if (onPick) onPick(binding);
        },
      })
    }
  />
);

const SetThemeEditor: EditorFor<'setActiveTheme'> = ({ action, ctx }) => (
  <LoginFieldEditor
    ctx={ctx}
    fieldKey="theme"
    label="Theme"
    value={action.theme}
    onChange={(v) => ctx.update({ theme: v })}
    onOpenBindingPicker={(onPick, currentBinding) =>
      ctx.openBindingPicker('', 'setActiveTheme-theme', {
        currentBinding: currentBinding ?? varBindingOf(action.theme),
        onPick: (binding) => {
          ctx.update({ theme: { $var: binding } });
          if (onPick) onPick(binding);
        },
      })
    }
  />
);

const SEVERITY_SCHEMA: SchemaField = { type: 'String', format: 'select', label: 'Severity' };
const DISCARD_SCHEMA: SchemaField = { type: 'String', format: 'select', label: 'Discard' };
const DURATION_SCHEMA: SchemaField = { type: 'Integer', label: 'Duration' };
const DISMISSIBLE_SCHEMA: SchemaField = { type: 'Boolean', label: 'Dismissible' };

const ShowToastEditor: EditorFor<'showToast'> = ({ action, ctx }) => (
  <>
    <LoginFieldEditor
      ctx={ctx}
      fieldKey="message"
      label="Message"
      value={action.message}
      onChange={(v) => ctx.update({ message: v })}
    />
    <ActionFieldRow ctx={ctx} fieldKey="severity" schema={SEVERITY_SCHEMA} label="Severity">
      <Select
        value={action.severity}
        onChange={(v) => ctx.update({ severity: v as 'info' | 'warning' | 'error' })}
      >
        <option value="info">Info</option>
        <option value="warning">Warning</option>
        <option value="error">Error</option>
      </Select>
    </ActionFieldRow>
    <ActionFieldRow ctx={ctx} fieldKey="discard" schema={DISCARD_SCHEMA} label="Discard">
      <Select
        value={action.discard}
        onChange={(v) => ctx.update({ discard: v as 'auto' | 'manual' })}
      >
        <option value="auto">Auto</option>
        <option value="manual">Manual</option>
      </Select>
    </ActionFieldRow>
    {action.discard === 'auto' && (
      <ActionFieldRow ctx={ctx} fieldKey="duration" schema={DURATION_SCHEMA} label="Duration (ms)">
        <input
          type="number"
          className="cfg-prop-input"
          min={500}
          step={500}
          value={action.duration ?? 4000}
          onChange={(e) =>
            ctx.update({ duration: e.target.value === '' ? 4000 : Number(e.target.value) })
          }
        />
      </ActionFieldRow>
    )}
  </>
);

const ShowAlertEditor: EditorFor<'showAlert'> = ({ action, ctx }) => {
  const NestedActions = ctx.ActionsInput;
  return (
    <>
      <ActionFieldRow
        ctx={ctx}
        fieldKey="dismissible"
        schema={DISMISSIBLE_SCHEMA}
        label="Dismissible"
      >
        <BoolButtonGroup
          value={action.dismissible ?? false}
          onChange={(v) => ctx.update({ dismissible: v })}
        />
      </ActionFieldRow>
      <LoginFieldEditor
        ctx={ctx}
        fieldKey="title"
        label="Title"
        value={action.title}
        onChange={(v) => ctx.update({ title: v })}
      />
      <LoginFieldEditor
        ctx={ctx}
        fieldKey="description"
        label="Description"
        value={action.description}
        onChange={(v) => ctx.update({ description: v })}
      />
      <LoginFieldEditor
        ctx={ctx}
        fieldKey="cancelText"
        label="Cancel Text"
        value={action.cancelText}
        onChange={(v) => ctx.update({ cancelText: v })}
      />
      <LoginFieldEditor
        ctx={ctx}
        fieldKey="okText"
        label="OK Text"
        value={action.okText}
        onChange={(v) => ctx.update({ okText: v })}
      />
      <NestedActions
        value={{ onCancel: action.onCancel ?? [] }}
        onChange={(v) => {
          const sub = v as Record<string, unknown>;
          ctx.update({ onCancel: (sub.onCancel ?? []) as ButtonAction[] });
        }}
        eventKey="onCancel"
        eventLabel="On Cancel"
        headerTitle="On Cancel"
        pathPrefix={ctx.path}
        resultFields={ctx.resultFields}
      />
      <NestedActions
        value={{ onOk: action.onOk ?? [] }}
        onChange={(v) => {
          const sub = v as Record<string, unknown>;
          ctx.update({ onOk: (sub.onOk ?? []) as ButtonAction[] });
        }}
        eventKey="onOk"
        eventLabel="On OK"
        headerTitle="On OK"
        pathPrefix={ctx.path}
        resultFields={ctx.resultFields}
      />
    </>
  );
};

const RecipeLoadEditor: EditorFor<'recipeLoad'> = ({ action, ctx }) => (
  <>
    <LoginFieldEditor
      ctx={ctx}
      fieldKey="datasetId"
      label="Dataset ID"
      value={action.datasetId}
      onChange={(v) => ctx.update({ datasetId: v })}
      onOpenBindingPicker={(onPick, currentBinding) =>
        ctx.openBindingPicker('', 'recipeLoad-datasetId', {
          currentBinding: currentBinding ?? varBindingOf(action.datasetId),
          onPick: (binding) => {
            ctx.update({ datasetId: { $var: binding } });
            if (onPick) onPick(binding);
          },
        })
      }
    />
    <ActionFieldRow
      ctx={ctx}
      fieldKey="verify"
      schema={{ type: 'boolean', label: 'Verify' }}
      label="Verify after load"
    >
      <BoolButtonGroup value={action.verify === true} onChange={(v) => ctx.update({ verify: v })} />
    </ActionFieldRow>
    <ResultHandlersSubrows action={action} actionType="recipeLoad" ctx={ctx} />
  </>
);

const RecipeSaveEditor: EditorFor<'recipeSave'> = ({ action, ctx }) => (
  <>
    <LoginFieldEditor
      ctx={ctx}
      fieldKey="datasetId"
      label="Dataset ID (blank = loaded)"
      value={action.datasetId}
      onChange={(v) => ctx.update({ datasetId: v })}
      onOpenBindingPicker={(onPick, currentBinding) =>
        ctx.openBindingPicker('', 'recipeSave-datasetId', {
          currentBinding: currentBinding ?? varBindingOf(action.datasetId),
          onPick: (binding) => {
            ctx.update({ datasetId: { $var: binding } });
            if (onPick) onPick(binding);
          },
        })
      }
    />
    <ResultHandlersSubrows action={action} actionType="recipeSave" ctx={ctx} />
  </>
);

// ── Registry ───────────────────────────────────────────────────────────────

type ActionEditors = {
  [K in ButtonAction['type']]?: EditorFor<K>;
};

export const ACTION_EDITORS: ActionEditors = {
  openDialog: OpenDialogEditor,
  closeDialog: CloseDialogEditor,
  openPageOverlay: OpenPageOverlayEditor,
  closePageOverlay: ClosePageOverlayEditor,
  writeDataVariable: WriteDataVariableEditor,
  recipeLoad: RecipeLoadEditor,
  recipeSave: RecipeSaveEditor,
  loginUser: LoginUserEditor,
  logoutUser: LogoutUserEditor,
  setLanguage: SetLanguageEditor,
  setActiveTheme: SetThemeEditor,
  showToast: ShowToastEditor,
  showAlert: ShowAlertEditor,
};
