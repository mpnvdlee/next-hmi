/**
 * Per-action-type editors for ActionsInput.
 *
 * Each editor is a small component keyed by `ButtonAction.type` in
 * ACTION_EDITORS. The parent ActionsInput dispatches by `action.type`,
 * so adding a new action means: add the variant to ButtonAction, write
 * an editor here, register it in the map.
 *
 * Editors share an ActionEditorCtx for parent callbacks (update, picker
 * openers) and computed lists (overlay targets).
 */

// File exports the ACTION_EDITORS registry alongside its component definitions —
// they belong together as the dispatch table.
/* eslint-disable react-refresh/only-export-components */

import { useContext, useMemo, type ComponentType, type ReactNode } from 'react';
import type {
  ButtonAction,
  OverlayPlacement,
  OverlaySize,
  PageNode,
  VariableBinding,
  WriteTarget,
} from '@shared/types/config';
import { writeTargetAddress } from '@shared/types/config';
import type { SchemaField } from '@shared/types/widgetSchema';
import { getWriteCoercionKind, type VariableWriteDescriptor } from '@config/utils/variableType';
import {
  canonicalOpcuaWriteType,
  coerceOpcuaWrite,
  WRITE_COERCION_MESSAGES,
} from '@shared/utils/opcuaWriteCoercion';
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
import {
  componentPropertyToSchemaField,
  type ComponentPropertySchema,
} from '@shared/types/componentProperty';
import { isPageGroup, resolvePageTitle } from '@shared/utils/pageTree';
import { ResultFieldsContext } from '../PropertySourceEditor/resultFieldsContext';
import { varBindingOf } from '../bindingPickerUtils';
import { BOOLEAN_SLOT, schemaFieldPicker, slotFilter } from '../PropertySourceEditor/editors/utils';
import { PanelScopeContext } from '@config/store/panelExpansionStore';
import { useFieldDiagnostic } from '@config/hooks/usePanelDiagnostics';
import { useComponentPropertySchema } from '../PropertySourceEditor/componentPropertySchemaContext';
import {
  useRepeatEditorScope,
  type RepeatEditorScope,
} from '../PropertySourceEditor/repeatScopeContext';
import { useEditorDomainStore, type PickerExtras } from '@config/store/domains/editorDomainStore';
import { repeatPickLabel } from '../VariableBindingPicker/repeatItemRows';
import PropertySourceSelector, { type PropertySource } from '../PropertySourceSelector';
import { getPropertySource } from '../propertyValueUtils';
import { RepeatItemEditor } from '../PropertySourceEditor/editors/leaf';
import { ComponentPropEditor } from '../PropertySourceEditor/editors/picker';
import { getDefaultValueForKind } from './actionMutations';

// ── Shared ─────────────────────────────────────────────────────────────────

/** Every node an Open/Close Page Overlay action may name — leaf pages *and*
 *  page groups — per page-tree root. Only a Dialogs-folder node takes input
 *  parameters. */
export interface OverlayTargets {
  dialogs: PageNode[];
  pages: PageNode[];
}

/** The overlay target with this id, and whether it is in the Dialogs folder. */
export function findOverlayTarget(
  targets: OverlayTargets,
  id: string | undefined,
): { node: PageNode; inDialogs: boolean } | null {
  const inDialogs = targets.dialogs.find((node) => node.id === id);
  if (inDialogs) return { node: inDialogs, inDialogs: true };
  const inPages = targets.pages.find((node) => node.id === id);
  return inPages ? { node: inPages, inDialogs: false } : null;
}

export interface ActionEditorCtx {
  /** Patch this action with the given partial. */
  update: (patch: Partial<ButtonAction>) => void;
  overlayTargets: OverlayTargets;
  /** Cached `data_type` for writeDataVariable bindings, keyed by `${ds}:${path}`. */
  dataTypes: Record<string, VariableWriteDescriptor>;
  /** Generic binding picker — for loginUser/setLanguage style fields. */
  openBindingPicker: (
    componentId: string,
    propertyKey: string,
    options?: PickerExtras & {
      onPick?: (binding: VariableBinding) => void;
      /** Binding the field holds today, so the picker opens on it. */
      currentBinding?: VariableBinding;
      /** What the field takes — drives the picker's filter and its ✓/✗. */
      filter?: { label?: string; type?: string | string[] };
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

/** Picker for a String action field: the pick is written into the field as `$var`
 *  and forwarded to the calling slot. */
function stringSlotPicker(
  ctx: ActionEditorCtx,
  pickerId: string,
  label: string,
  current: unknown,
  write: (value: { $var: VariableBinding }) => void,
): OpenBindingPicker {
  return (onPick, currentBinding, slot) =>
    ctx.openBindingPicker('', pickerId, {
      filter: slotFilter({ label, type: 'String' }, slot),
      currentBinding: currentBinding ?? varBindingOf(current),
      onPick: (binding) => {
        write({ $var: binding });
        if (onPick) onPick(binding);
      },
    });
}

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
  | 'loginUser'
  | 'logoutUser'
  | 'writeDataVariable'
  | 'toggleDataVariable'
  | 'recipeLoad'
  | 'recipeSave';

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
  toggleDataVariable: {
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

/**
 * The "Input Parameters" section `openDialog` grows for a target that declares
 * any: one row per input parameter, holding the value the action passes in.
 */
function ActionComponentProperties({
  declared,
  values,
  onChange,
}: {
  declared: Record<string, ComponentPropertySchema> | undefined;
  values: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const fields = useMemo(
    () =>
      Object.entries(declared ?? {}).map(
        ([key, schema]) => [key, componentPropertyToSchemaField(schema)] as const,
      ),
    [declared],
  );
  const openBindingPicker = useEditorDomainStore((s) => s.openBindingPicker);
  if (fields.length === 0) return null;

  function patch(key: string, value: unknown) {
    const next = { ...values };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onChange(next);
  }

  return (
    <div className="cfg-section cfg-section--flush">
      <div className="cfg-section__title">Input Parameters</div>
      {fields.map(([key, field]) => (
        <SchemaFieldRow
          key={key}
          schema={field}
          value={values[key]}
          onChange={(v) => patch(key, v)}
          onOpenPicker={schemaFieldPicker(openBindingPicker, field, (binding) =>
            patch(key, { $var: binding }),
          )}
          allProperties={values}
        />
      ))}
    </div>
  );
}

const PAGE_SCHEMA: SchemaField = { type: 'String', format: 'select', label: 'Page' };
const DIALOG_SCHEMA: SchemaField = { type: 'String', format: 'select', label: 'Dialog' };
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

type OverlayAction = Extract<ButtonAction, { type: 'openDialog' | 'openPageOverlay' }>;

/** Placement and sizing fields of the page-overlay action. */
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

/** `<option>` per node. A group is labelled as one: it opens its active child
 *  inside its own chrome, which is a different thing from opening that child on
 *  its own. */
function overlayTargetOptions(nodes: PageNode[]) {
  return nodes.map((node) => (
    <option key={node.id} value={node.id}>
      {resolvePageTitle(node.title)}
      {isPageGroup(node) ? ' (page group)' : ''}
    </option>
  ));
}

/** Both roots, each in its own group — the close action closes either kind, so
 *  its picker is the only one that still spans the whole page tree. */
function everyOverlayTargetOption(targets: OverlayTargets) {
  return (
    <>
      {targets.dialogs.length > 0 && (
        <optgroup label="Dialogs">{overlayTargetOptions(targets.dialogs)}</optgroup>
      )}
      {targets.pages.length > 0 && (
        <optgroup label="Pages">{overlayTargetOptions(targets.pages)}</optgroup>
      )}
    </>
  );
}

const OpenDialogEditor: EditorFor<'openDialog'> = ({ action, ctx }) => {
  const target = findOverlayTarget(ctx.overlayTargets, action.pageId);
  return (
    <>
      <ActionFieldRow ctx={ctx} fieldKey="pageId" schema={DIALOG_SCHEMA} label="Dialog">
        <Select value={action.pageId} onChange={(v) => ctx.update({ pageId: v })}>
          <option value="">— select dialog —</option>
          {overlayTargetOptions(ctx.overlayTargets.dialogs)}
        </Select>
      </ActionFieldRow>
      <OverlayLayoutFields action={action} ctx={ctx} defaultSize="medium" />
      {target?.inDialogs && (
        <ActionComponentProperties
          declared={target.node.componentProperties}
          values={action.componentProperties ?? {}}
          onChange={(next) => ctx.update({ componentProperties: next })}
        />
      )}
    </>
  );
};

const OpenPageOverlayEditor: EditorFor<'openPageOverlay'> = ({ action, ctx }) => {
  return (
    <>
      <ActionFieldRow ctx={ctx} fieldKey="pageId" schema={PAGE_SCHEMA} label="Page">
        <Select value={action.pageId} onChange={(v) => ctx.update({ pageId: v })}>
          <option value="">— select page —</option>
          {overlayTargetOptions(ctx.overlayTargets.pages)}
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
        <option value="">Top-most overlay</option>
        {everyOverlayTargetOption(ctx.overlayTargets)}
      </Select>
    </ActionFieldRow>
  );
};

const WRITE_TARGET_FILTER = {
  label: 'Write Data Variable target',
  write: true,
  type: ['String', 'Boolean', 'Integer', 'Float', 'DateTime', 'Date', 'Time', 'Duration'],
};
const TOGGLE_TARGET_FILTER = { label: 'Toggle target', write: true, type: ['Boolean'] };

/** The copy's element a Repeat-item target names, or undefined for a `$var`. */
function repeatTargetOf(target: WriteTarget | undefined): { member?: string } | undefined {
  return target && '$repeatItem' in target ? target.$repeatItem : undefined;
}

/** The descriptor cached for a `$var` target — keyed by its `ds:path[N]`. */
function varTargetDescriptor(
  target: WriteTarget | undefined,
  dataTypes: ActionEditorCtx['dataTypes'],
): ActionEditorCtx['dataTypes'][string] | undefined {
  const address = writeTargetAddress(target);
  return address ? dataTypes[`${address.datasource}:${address.path}`] : undefined;
}

/** A Repeat-item target writes the element's type, or its member's. */
function writeTargetType(
  target: WriteTarget | undefined,
  scope: RepeatEditorScope | null,
  dataTypes: ActionEditorCtx['dataTypes'],
): string | undefined {
  const repeat = repeatTargetOf(target);
  if (!repeat) return varTargetDescriptor(target, dataTypes)?.dataType;
  return repeat.member ? scope?.memberTypes?.[repeat.member] : scope?.elementType;
}

/**
 * A write/toggle target: a datasource variable, or — inside a Repeater — the
 * copy's own element. Each is its own source with its own picker. The element
 * is always this copy's; only a struct element asks which member to write.
 */
function WriteTargetRow({
  action,
  ctx,
  filter,
  diagnostic,
}: {
  action: { target?: WriteTarget };
  ctx: ActionEditorCtx;
  filter: { label: string; write: boolean; type: string[] };
  diagnostic?: { level: 'error' | 'warning'; message: string };
}) {
  const scope = useRepeatEditorScope();
  const target = repeatTargetOf(action.target);
  const address = writeTargetAddress(action.target);
  const active: PropertySource = target ? '$repeatItem' : '$var';
  const members = scope?.members ?? [];
  const pill =
    scope || target ? (
      <PropertySourceSelector
        compact
        value={target ? { $repeatItem: {} } : { $var: { path: '' } }}
        source={active}
        fieldType="string"
        forcedSources={['$var']}
        includeStatic={false}
        scopeSources={['$repeatItem']}
        label="Variable"
        onChange={(v) => {
          const next = getPropertySource(v);
          if (next === active) return;
          ctx.update({
            target: next === '$repeatItem' ? { $repeatItem: {} } : undefined,
          } as Partial<ButtonAction>);
        }}
      />
    ) : undefined;

  let field: ReactNode;
  if (target && members.length > 0) {
    field = (
      <PickerField
        mono
        displayText={
          target.member ? repeatPickLabel({ field: 'value', member: target.member }) : ''
        }
        emptyLabel="Choose a member"
        pickTitle="Choose the member to write"
        onPick={
          scope
            ? () =>
                ctx.openBindingPicker('', 'writeTarget', {
                  filter,
                  repeatItem: {
                    scope,
                    writeTarget: true,
                    current: target.member ? { field: 'value', member: target.member } : undefined,
                    onPick: (pick) =>
                      ctx.update({
                        target: { $repeatItem: pick.member ? { member: pick.member } : {} },
                      } as Partial<ButtonAction>),
                  },
                })
            : undefined
        }
      />
    );
  } else if (target) {
    field = <PickerField mono displayText="Repeat item › Element (this copy)" />;
  } else {
    field = (
      <PickerField
        mono
        displayText={address ? `${address.datasource}:${address.path}` : ''}
        emptyLabel="Not bound"
        pickTitle="Change variable binding"
        onPick={() => ctx.openWriteVarPicker()}
      />
    );
  }

  const repeatDiagnostic =
    target && !scope
      ? { level: 'warning' as const, message: 'Only meaningful inside a Repeater.' }
      : target && !scope?.writable
        ? {
            level: 'warning' as const,
            message:
              'This Repeater does not repeat over a variable, so its elements cannot be written.',
          }
        : undefined;

  return (
    <PropRow label="Variable" badge={pill} diagnostic={repeatDiagnostic ?? diagnostic}>
      {field}
    </PropRow>
  );
}

const WriteDataVariableEditor: EditorFor<'writeDataVariable'> = ({ action, ctx }) => {
  // The backend anchors write-target diagnostics (unknown datasource/variable,
  // test-server target) on the action's `target` slot — see
  // `_validate_write_target` in core/validation/structure.py.
  const widgetId = useContext(PanelScopeContext);
  const targetDiagnostic = useFieldDiagnostic(widgetId, [...ctx.path, 'target']);
  const repeatScope = useRepeatEditorScope();
  const inputScope = useComponentPropertySchema();
  const descriptor = varTargetDescriptor(action.target, ctx.dataTypes);
  const targetType = writeTargetType(action.target, repeatScope, ctx.dataTypes);
  const valueKind = getWriteCoercionKind(targetType);
  const canonicalType = canonicalOpcuaWriteType(targetType);
  const valueSource = getPropertySource(action.value) ?? 'static';
  const sourced = valueSource !== 'static';
  const validation =
    descriptor && !sourced
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
  // The value's own sources: a fixed value, or — in a dialog's events — one of
  // its input parameters, or — inside a Repeater — the copy's element.
  const valuePill =
    inputScope || repeatScope || sourced ? (
      <PropertySourceSelector
        compact
        value={action.value}
        source={valueSource}
        fieldType={valueSchema.type as string}
        defaultValue={getDefaultValueForKind(valueKind)}
        forcedSources={['static']}
        scopeSources={['$componentProp', '$repeatItem']}
        label="Value"
        onChange={(v) => {
          if (getPropertySource(v) !== valueSource) ctx.update({ value: v as typeof action.value });
        }}
      />
    ) : undefined;
  const valueFilter = { label: 'Value', ...(canonicalType && { type: canonicalType }) };
  return (
    <>
      <WriteTargetRow
        action={action}
        ctx={ctx}
        filter={WRITE_TARGET_FILTER}
        diagnostic={targetDiagnostic}
      />
      {valueSource === '$repeatItem' && (
        <PropRow label="Value" badge={valuePill}>
          <RepeatItemEditor
            value={action.value}
            onChange={(v) => ctx.update({ value: v as typeof action.value })}
            onOpenBindingPicker={(_onPick, _current, _slot, extras) =>
              ctx.openBindingPicker('', 'writeValue', { ...extras, filter: valueFilter })
            }
          />
        </PropRow>
      )}
      {valueSource === '$componentProp' && (
        <PropRow label="Value" badge={valuePill}>
          <ComponentPropEditor
            value={action.value}
            onChange={(v) => ctx.update({ value: v as typeof action.value })}
            schema={{ ...valueSchema, ...(canonicalType && { type: canonicalType }) }}
          />
        </PropRow>
      )}
      {!sourced && (
        <PropRow
          label="Value"
          badge={valuePill}
          selection={{ path: [...ctx.path, 'value'], schema: valueSchema }}
          block={descriptor?.isArray && !descriptor.indexed}
          diagnostic={
            validation?.ok === false
              ? { level: 'error', message: WRITE_COERCION_MESSAGES[validation.reason] }
              : undefined
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
              {WRITE_COERCION_MESSAGES[validation.reason]}
            </span>
          )}
        </PropRow>
      )}
      <ResultHandlersSubrows action={action} actionType="writeDataVariable" ctx={ctx} />
    </>
  );
};

const CONDITION_SCHEMA: SchemaField = { type: 'Boolean', label: 'Condition' };

const IfEditor: EditorFor<'if'> = ({ action, ctx }) => {
  const NestedActions = ctx.ActionsInput;
  const branches = [
    { key: 'then', label: 'Then' },
    { key: 'else', label: 'Else' },
  ] as const;
  return (
    <>
      <ParentPathContext.Provider value={[...ctx.path, 'condition']}>
        <CollapsiblePropertyCard
          title="Condition"
          value={action.condition}
          onChange={(v) => ctx.update({ condition: v })}
          schema={CONDITION_SCHEMA}
          slot={BOOLEAN_SLOT}
          onOpenBindingPicker={(onPick, currentBinding, slot, extras) =>
            ctx.openBindingPicker('', 'if-condition', {
              ...extras,
              // A nested operand with a type of its own (a comparison's, a
              // formula's) replaces the condition's Boolean.
              filter: slotFilter({ label: 'Condition', type: 'Boolean' }, slot),
              currentBinding: currentBinding ?? varBindingOf(action.condition),
              // A nested source (a comparison's operand) supplies its own
              // onPick; only a bare condition is replaced by the binding.
              onPick: (binding) =>
                onPick ? onPick(binding) : ctx.update({ condition: { $var: binding } }),
            })
          }
        />
      </ParentPathContext.Provider>
      {branches.map(({ key, label }) => (
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
          resultFields={ctx.resultFields}
        />
      ))}
    </>
  );
};

const ToggleDataVariableEditor: EditorFor<'toggleDataVariable'> = ({ action, ctx }) => {
  const widgetId = useContext(PanelScopeContext);
  const targetDiagnostic = useFieldDiagnostic(widgetId, [...ctx.path, 'target']);
  const repeatScope = useRepeatEditorScope();
  const targetType = writeTargetType(action.target, repeatScope, ctx.dataTypes);
  const notBoolean = targetType !== undefined && canonicalOpcuaWriteType(targetType) !== 'Boolean';
  return (
    <>
      <WriteTargetRow
        action={action}
        ctx={ctx}
        filter={TOGGLE_TARGET_FILTER}
        diagnostic={
          notBoolean
            ? { level: 'error', message: 'Only a Boolean variable can be toggled.' }
            : targetDiagnostic
        }
      />
      <ResultHandlersSubrows action={action} actionType="toggleDataVariable" ctx={ctx} />
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
      onOpenBindingPicker={stringSlotPicker(
        ctx,
        'loginUser-username',
        'Username',
        action.username,
        (v) => ctx.update({ username: v }),
      )}
    />
    <LoginFieldEditor
      ctx={ctx}
      fieldKey="password"
      label="Password"
      value={action.password}
      onChange={(v) => ctx.update({ password: v })}
      onOpenBindingPicker={stringSlotPicker(
        ctx,
        'loginUser-password',
        'Password',
        action.password,
        (v) => ctx.update({ password: v }),
      )}
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
    onOpenBindingPicker={stringSlotPicker(
      ctx,
      'setLanguage-language',
      'Language',
      action.language,
      (v) => ctx.update({ language: v }),
    )}
  />
);

const SetThemeEditor: EditorFor<'setActiveTheme'> = ({ action, ctx }) => (
  <LoginFieldEditor
    ctx={ctx}
    fieldKey="theme"
    label="Theme"
    value={action.theme}
    onChange={(v) => ctx.update({ theme: v })}
    onOpenBindingPicker={stringSlotPicker(ctx, 'setActiveTheme-theme', 'Theme', action.theme, (v) =>
      ctx.update({ theme: v }),
    )}
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
        onChange={(v) => ctx.update({ severity: v as 'info' | 'success' | 'warning' | 'error' })}
      >
        <option value="info">Info</option>
        <option value="success">Success</option>
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
      onOpenBindingPicker={stringSlotPicker(
        ctx,
        'recipeLoad-datasetId',
        'Dataset ID',
        action.datasetId,
        (v) => ctx.update({ datasetId: v }),
      )}
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
      onOpenBindingPicker={stringSlotPicker(
        ctx,
        'recipeSave-datasetId',
        'Dataset ID',
        action.datasetId,
        (v) => ctx.update({ datasetId: v }),
      )}
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
  openPageOverlay: OpenPageOverlayEditor,
  closePageOverlay: ClosePageOverlayEditor,
  writeDataVariable: WriteDataVariableEditor,
  toggleDataVariable: ToggleDataVariableEditor,
  if: IfEditor,
  recipeLoad: RecipeLoadEditor,
  recipeSave: RecipeSaveEditor,
  loginUser: LoginUserEditor,
  logoutUser: LogoutUserEditor,
  setLanguage: SetLanguageEditor,
  setActiveTheme: SetThemeEditor,
  showToast: ShowToastEditor,
  showAlert: ShowAlertEditor,
};
