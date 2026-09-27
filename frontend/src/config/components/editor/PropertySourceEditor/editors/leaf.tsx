import { useEffect } from 'react';
import ReadOnlyValue from '../../../ui/ReadOnlyValue';
import TranslationInput from '../../TranslationInput';
import PropRow from '../../../ui/PropRow';
import BoolButtonGroup from '../../../ui/BoolButtonGroup';
import Select from '../../../ui/Select';
import PageSelect from '../../../ui/PageSelect';
import GroupsEditor from '../../PropertiesPanel/GroupsEditor';
import PathInputField, { PickerField } from '../../../ui/PathInputField';
import { REPEAT_INDEX_SUFFIX, repeatPickLabel } from '../../VariableBindingPicker/repeatItemRows';
import { useResultFields } from '../resultFieldsContext';
import { useRepeatEditorScope } from '../repeatScopeContext';
import { varBindingOf } from '../../bindingPickerUtils';
import type { OpenBindingPicker } from './utils';
import type {
  DeviceSource,
  LocSource,
  PageField,
  PageIsActiveSource,
  PageSource,
  RandomSource,
  RepeatItemSource,
  TimeSource,
  UrlParamSource,
  UserGroupsSource,
  UserSource,
  VariableBinding,
  VarSource,
  ViewportSource,
} from '@shared/types/config';
import { useRecipeConfigStore } from '@config/store/recipeConfigStore';
import { sourceFieldFits, type FieldSelectingSource } from '@hmi/utils/propertySourceRegistry';

/** Parse a typed `datasource:location[n]` string into a VariableBinding. */
function parseVarPathInput(text: string): { path: string; index?: number } {
  const trimmed = text.trim();
  const m = trimmed.match(/^(.*)\[(\d+)\]$/);
  return m ? { path: m[1], index: parseInt(m[2], 10) } : { path: trimmed };
}

/**
 * The choices of a source's `field` selector that fit the field it sits in.
 * The stored choice stays listed even when it does not fit — marked, so an
 * existing value never changes by itself. No `fieldType` lists them all.
 */
function fittingFieldOptions<T extends string>(
  source: FieldSelectingSource,
  options: readonly { value: T; label: string }[],
  current: string | undefined,
  fieldType: string | readonly string[] | undefined,
): { value: T; label: string }[] {
  if (!fieldType) return [...options];
  return options.flatMap((o) =>
    sourceFieldFits(source, o.value, fieldType)
      ? [o]
      : o.value === current
        ? [{ value: o.value, label: `${o.label} (does not fit this field)` }]
        : [],
  );
}

/**
 * Sub-editor for $var wrapper — a typable `datasource:location[n]` path with a
 * picker button shortcut. Commits on blur/Enter; Escape reverts to the value at
 * focus time. The `✎` button still opens the full binding picker overlay.
 */
export function VarEditor({
  value,
  onChange,
  onOpenBindingPicker,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  onOpenBindingPicker?: OpenBindingPicker;
}) {
  const repeatScope = useRepeatEditorScope();
  const varObj = (value as VarSource)?.$var ?? { path: '' };
  const basePath = varObj.path ?? '';
  const repeatIndex = varObj.repeatIndex === true;
  const committedText = !basePath
    ? ''
    : repeatIndex
      ? `${basePath}${REPEAT_INDEX_SUFFIX}`
      : varObj.index !== undefined
        ? `${basePath}[${varObj.index}]`
        : basePath;

  return (
    <PathInputField
      value={committedText}
      placeholder={
        repeatScope ? `datasource:location${REPEAT_INDEX_SUFFIX}` : 'datasource:location'
      }
      titleFromDraft
      onCommit={(text) => {
        const trimmed = text.trim();
        const next: VariableBinding = trimmed.endsWith(REPEAT_INDEX_SUFFIX)
          ? { path: trimmed.slice(0, -REPEAT_INDEX_SUFFIX.length), repeatIndex: true }
          : parseVarPathInput(text);
        if (
          next.path === basePath &&
          next.index === varObj.index &&
          next.repeatIndex === varObj.repeatIndex
        )
          return;
        onChange({ $var: next });
      }}
      pickTitle="Change variable binding"
      // This field is the innermost slot that knows its own binding, so it names
      // the preselect outright rather than letting an enclosing `wrapPicker`
      // guess from a composite value.
      onPick={
        onOpenBindingPicker
          ? () =>
              onOpenBindingPicker(
                undefined,
                varBindingOf(value),
                undefined,
                repeatScope ? { repeatIndex: true } : undefined,
              )
          : undefined
      }
      onClear={onOpenBindingPicker && committedText ? () => onChange(undefined) : undefined}
    />
  );
}

/** `$repeatItem` — one line like a variable binding, picked in the binding
 *  picker beside the variables. Outside a Repeater the validator warns. */
export function RepeatItemEditor({
  value,
  onChange,
  onOpenBindingPicker,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  onOpenBindingPicker?: OpenBindingPicker;
}) {
  const scope = useRepeatEditorScope();
  const obj = (value as RepeatItemSource)?.$repeatItem ?? {};
  const pick: RepeatItemSource['$repeatItem'] =
    obj.field === 'index'
      ? { field: 'index' }
      : { field: 'value', ...(obj.member && { member: obj.member }) };
  const openPicker =
    scope && onOpenBindingPicker
      ? () =>
          onOpenBindingPicker(undefined, undefined, undefined, {
            repeatItem: {
              scope,
              current: pick,
              onPick: (next) => onChange({ $repeatItem: next }),
            },
          })
      : undefined;

  // An element whose shape only the runtime knows (an API response) lists no
  // members to pick, so its member path is typed here instead.
  if (scope?.members === null && pick.field === 'value') {
    return (
      <PathInputField
        value={pick.member ?? ''}
        placeholder="Whole element — or a member, e.g. name"
        titleFromDraft
        onCommit={(text) =>
          onChange({
            $repeatItem: text.trim() ? { field: 'value', member: text.trim() } : { field: 'value' },
          })
        }
        pickTitle="Change binding"
        onPick={openPicker}
      />
    );
  }
  return (
    <PickerField
      displayText={repeatPickLabel(pick)}
      pickTitle="Change binding"
      onPick={openPicker}
    />
  );
}

export function LocEditor({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const locKey = (value as LocSource)?.$loc ?? '';

  return (
    <TranslationInput
      value={{ $loc: locKey }}
      onChange={(next) => {
        if (next && typeof next === 'object' && '$loc' in (next as Record<string, unknown>)) {
          onChange(next);
          return;
        }
        onChange({ $loc: String(next ?? '') });
      }}
      translationOnly
    />
  );
}

export function UrlParamEditor({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const urlObj = (value as UrlParamSource)?.$urlParam ?? { name: '', default: undefined };

  return (
    <>
      <p className="cfg-prop-hint">
        Reads <code>?name=value</code> from the page URL. Falls back to the default when missing.
      </p>
      <PropRow label="Parameter Name">
        <input
          className="cfg-prop-input"
          type="text"
          value={urlObj.name || ''}
          onChange={(e) => onChange({ $urlParam: { ...urlObj, name: e.target.value } })}
          placeholder="e.g., deviceId"
        />
      </PropRow>
      <PropRow label="Default Value">
        <input
          className="cfg-prop-input"
          type="text"
          value={String(urlObj.default ?? '')}
          onChange={(e) =>
            onChange({ $urlParam: { ...urlObj, default: e.target.value || undefined } })
          }
          placeholder="(leave empty for none)"
        />
      </PropRow>
    </>
  );
}

export function PageIsActiveEditor({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const pageObj = (value as PageIsActiveSource)?.$pageIsActive ?? {};

  return (
    <>
      <p className="cfg-prop-hint">
        True while the selected page (or the current page, if none is picked) is active.
      </p>
      <PropRow label="Page">
        <PageSelect
          value={pageObj.page ?? ''}
          onChange={(v) => onChange({ $pageIsActive: v ? { page: v } : {} })}
          emptyLabel="(Current page)"
        />
      </PropRow>
    </>
  );
}

export function RandomEditor({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const randObj = (value as RandomSource)?.$random ?? { min: 0, max: 100, integer: true };

  return (
    <>
      <PropRow label="Minimum">
        <input
          className="cfg-prop-input"
          type="number"
          value={randObj.min ?? 0}
          onChange={(e) =>
            onChange({ $random: { ...randObj, min: parseFloat(e.target.value) || 0 } })
          }
        />
      </PropRow>
      <PropRow label="Maximum">
        <input
          className="cfg-prop-input"
          type="number"
          value={randObj.max ?? 100}
          onChange={(e) =>
            onChange({ $random: { ...randObj, max: parseFloat(e.target.value) || 100 } })
          }
        />
      </PropRow>
      <PropRow label="Round values">
        <BoolButtonGroup
          value={randObj.integer ?? true}
          onChange={(v) => onChange({ $random: { ...randObj, integer: v } })}
        />
      </PropRow>
    </>
  );
}

const USER_FIELD_OPTIONS = [
  { value: 'username', label: 'username' },
  { value: 'groups', label: 'groups' },
  { value: 'userList', label: 'User list' },
] as const;

export function UserFieldEditor({
  value,
  onChange,
  listOnly = false,
  fieldType,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  /** An option-list field takes a list, so only the list-valued fields apply. */
  listOnly?: boolean;
  /** The type(s) the field takes; lists only the choices that fit one. */
  fieldType?: string | readonly string[];
}) {
  const userObj = (value as UserSource)?.$user ?? { field: listOnly ? 'userList' : 'username' };

  if (listOnly) {
    return (
      <PropRow label="List" description="Fills the options from the project's users or groups.">
        <Select
          value={userObj.field === 'groups' ? 'groups' : 'userList'}
          onChange={(v) => onChange({ $user: { field: v } })}
        >
          <option value="userList">All users</option>
          <option value="groups">All user groups</option>
        </Select>
      </PropRow>
    );
  }

  return (
    <>
      <PropRow label="Field" description="Reads a field from the currently signed-in user.">
        <Select
          value={userObj.field ?? 'username'}
          onChange={(v) => onChange({ $user: { field: v } })}
        >
          {fittingFieldOptions(
            '$user',
            USER_FIELD_OPTIONS,
            userObj.field ?? 'username',
            fieldType,
          ).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </PropRow>
    </>
  );
}

export function UserGroupsEditor({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const groups = (value as UserGroupsSource)?.$userGroups?.groups ?? [];
  return (
    <>
      <p className="cfg-prop-hint">
        Shows for users in one of the selected groups. Empty = everyone.
      </p>
      <GroupsEditor
        value={groups}
        onChange={(next) => onChange({ $userGroups: { groups: Array.isArray(next) ? next : [] } })}
      />
    </>
  );
}

const DEVICE_FIELD_OPTIONS = [
  { value: 'hostname', label: 'Hostname' },
  { value: 'ipAddress', label: 'IP address' },
  { value: 'macAddress', label: 'MAC address' },
] as const;

export function DeviceFieldEditor({
  value,
  onChange,
  fieldType,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  /** The type(s) the field takes; lists only the choices that fit one. */
  fieldType?: string | readonly string[];
}) {
  const deviceObj = (value as DeviceSource)?.$device ?? { field: 'hostname' as const };

  return (
    <>
      <PropRow label="Field" description="Reads a field from the device running this display.">
        <Select
          value={deviceObj.field ?? 'hostname'}
          onChange={(v) => onChange({ $device: { field: v as DeviceSource['$device']['field'] } })}
        >
          {fittingFieldOptions(
            '$device',
            DEVICE_FIELD_OPTIONS,
            deviceObj.field ?? 'hostname',
            fieldType,
          ).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </PropRow>
    </>
  );
}

export function TimeEditor({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const timeObj = (value as TimeSource)?.$time ?? { format: 'HH:mm:ss', timezone: '' };

  return (
    <>
      <p className="cfg-prop-hint">Shows the current time, formatted.</p>
      <PropRow label="Format">
        <input
          className="cfg-prop-input"
          type="text"
          value={timeObj.format ?? 'HH:mm:ss'}
          onChange={(e) => onChange({ $time: { ...timeObj, format: e.target.value } })}
          placeholder="HH:mm:ss or YYYY-MM-DD HH:mm"
        />
      </PropRow>
      <PropRow label="Timezone">
        <input
          className="cfg-prop-input"
          type="text"
          value={timeObj.timezone ?? ''}
          onChange={(e) => onChange({ $time: { ...timeObj, timezone: e.target.value } })}
          placeholder="Local timezone (empty) or e.g. UTC"
        />
      </PropRow>
    </>
  );
}

export function LanguagesEditor() {
  return (
    <PropRow label="Source">
      <ReadOnlyValue>Language list</ReadOnlyValue>
    </PropRow>
  );
}

const ALARM_COUNT_FILTER_OPTIONS = [
  { value: 'all', label: 'All active alarms' },
  { value: 'unacked', label: 'Unacknowledged alarms' },
  { value: 'error', label: 'Error level only' },
  { value: 'warning', label: 'Warning level only' },
  { value: 'info', label: 'Info level only' },
];

const PAGE_FIELD_OPTIONS: { value: PageField; label: string }[] = [
  { value: 'title', label: 'Title' },
  { value: 'breadcrumbLabel', label: 'Breadcrumb label' },
  { value: 'description', label: 'Description' },
  { value: 'icon', label: 'Icon' },
  { value: 'id', label: 'Page id' },
  { value: 'parentId', label: 'Parent id' },
  { value: 'depth', label: 'Depth' },
  { value: 'pathString', label: 'Path string' },
  { value: 'pathSegments', label: 'Path segments (JSON)' },
];

export function PageEditor({
  value,
  onChange,
  fieldType,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  /** The type(s) the field takes; lists only the choices that fit one. */
  fieldType?: string | readonly string[];
}) {
  const obj = (value as PageSource)?.$page ?? { field: 'title' as const };
  const isPathString = obj.field === 'pathString';

  return (
    <>
      <p className="cfg-prop-hint">
        Reads a field from a page (current active page when id is blank).
      </p>
      <PropRow label="Field">
        <Select
          value={obj.field ?? 'title'}
          onChange={(v) => onChange({ $page: { ...obj, field: v as PageField } })}
        >
          {fittingFieldOptions('$page', PAGE_FIELD_OPTIONS, obj.field ?? 'title', fieldType).map(
            (o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ),
          )}
        </Select>
      </PropRow>
      <PropRow label="Page">
        <PageSelect
          value={obj.pageId ?? ''}
          onChange={(v) => onChange({ $page: { ...obj, pageId: v } })}
          emptyLabel="(Current active page)"
          // Reads a page rather than going to it, and resolves against both
          // roots — a Dialogs-folder page has a title and a path to report.
          include="all"
        />
      </PropRow>
      {isPathString && (
        <PropRow label="Separator">
          <input
            className="cfg-prop-input"
            type="text"
            value={obj.separator ?? ''}
            onChange={(e) =>
              onChange({ $page: { ...obj, separator: e.target.value || undefined } })
            }
            placeholder=" / "
          />
        </PropRow>
      )}
    </>
  );
}

const VIEWPORT_FIELD_OPTIONS: {
  value: 'size' | 'width' | 'height' | 'orientation';
  label: string;
}[] = [
  { value: 'size', label: 'Size class (phone / tablet / laptop)' },
  { value: 'width', label: 'Width (px)' },
  { value: 'height', label: 'Height (px)' },
  { value: 'orientation', label: 'Orientation' },
];

export function ViewportEditor({
  value,
  onChange,
  fieldType,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  /** The type(s) the field takes; lists only the choices that fit one. */
  fieldType?: string | readonly string[];
}) {
  const obj = (value as ViewportSource)?.$viewport ?? { field: 'size' as const };
  return (
    <>
      <PropRow label="Field" description="Reads a property of the current browser viewport.">
        <Select
          value={obj.field ?? 'size'}
          onChange={(v) =>
            onChange({ $viewport: { field: v as 'size' | 'width' | 'height' | 'orientation' } })
          }
        >
          {fittingFieldOptions(
            '$viewport',
            VIEWPORT_FIELD_OPTIONS,
            obj.field ?? 'size',
            fieldType,
          ).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </PropRow>
    </>
  );
}

export function AlarmCountEditor({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const acObj = (value as { $alarmCount?: { filter?: string } })?.$alarmCount ?? {
    filter: 'unacked',
  };

  return (
    <>
      <PropRow label="Filter" description="Count of active alarms matching the filter.">
        <Select
          value={acObj.filter ?? 'unacked'}
          onChange={(v) => onChange({ $alarmCount: { ...acObj, filter: v } })}
        >
          {ALARM_COUNT_FILTER_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </Select>
      </PropRow>
    </>
  );
}

const RECIPE_FIELD_OPTIONS = [
  { value: 'activeName', label: 'Loaded recipe name' },
  { value: 'loaded', label: 'Is loaded' },
  { value: 'parametersChanged', label: 'Parameters changed' },
];

export function RecipeEditor({
  value,
  onChange,
  fieldType,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  /** The type(s) the field takes; lists only the choices that fit one. */
  fieldType?: string | readonly string[];
}) {
  const config = useRecipeConfigStore((s) => s.config);
  const load = useRecipeConfigStore((s) => s.load);
  useEffect(() => {
    void load();
  }, [load]);

  const obj = (value as { $recipe?: { type?: string; field?: string } })?.$recipe ?? {
    type: '',
    field: 'parametersChanged',
  };
  const types = config?.datasetTypes ?? [];

  return (
    <>
      <PropRow label="Dataset type" tier={2}>
        <Select value={obj.type ?? ''} onChange={(v) => onChange({ $recipe: { ...obj, type: v } })}>
          <option value="">Select a type…</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name || t.id}
            </option>
          ))}
        </Select>
      </PropRow>
      <PropRow label="Field" tier={2}>
        <Select
          value={obj.field ?? 'parametersChanged'}
          onChange={(v) => onChange({ $recipe: { ...obj, field: v } })}
        >
          {fittingFieldOptions(
            '$recipe',
            RECIPE_FIELD_OPTIONS,
            obj.field ?? 'parametersChanged',
            fieldType,
          ).map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </Select>
      </PropRow>
    </>
  );
}

export function RecipeListEditor({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const config = useRecipeConfigStore((s) => s.config);
  const load = useRecipeConfigStore((s) => s.load);
  useEffect(() => {
    void load();
  }, [load]);

  const obj = (value as { $recipeList?: { type?: string } })?.$recipeList ?? { type: '' };
  const types = config?.datasetTypes ?? [];

  return (
    <PropRow label="Dataset type">
      <Select
        value={obj.type ?? ''}
        onChange={(v) => onChange({ $recipeList: { ...obj, type: v } })}
      >
        <option value="">All types</option>
        {types.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name || t.id}
          </option>
        ))}
      </Select>
    </PropRow>
  );
}

const RESULT_FIELD_PRESETS = ['reason', 'datasource', 'path', 'username', 'groups', 'groupLabels'];

export function ResultEditor({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const contextFields = useResultFields();
  const options = contextFields ?? RESULT_FIELD_PRESETS;
  const raw = (value as { $result?: unknown })?.$result;
  const field = typeof raw === 'string' ? raw : '';
  const inOptions = options.includes(field);
  const isCustom = field !== '' && !inOptions;

  // Auto-correct the registry default ('reason') when it isn't a populated
  // field for this slot — e.g. landed inside loginUser.onSuccess after picking
  // $result mode. Only the literal default is rewritten so user-typed Custom
  // values are left alone.
  useEffect(() => {
    if (
      contextFields &&
      contextFields.length > 0 &&
      field === 'reason' &&
      !contextFields.includes('reason')
    ) {
      onChange({ $result: contextFields[0] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextFields]);

  return (
    <div className="cfg-result-editor">
      <p className="cfg-prop-hint">
        Reads a field from the backend response. Only meaningful inside an async action&apos;s On
        Success / On Failed / On Settled handler — resolves to null elsewhere.
      </p>
      <PropRow label="Field">
        <Select
          value={isCustom ? '__custom__' : inOptions ? field : (options[0] ?? 'reason')}
          onChange={(v) => {
            if (v === '__custom__') {
              onChange({ $result: isCustom ? field : '' });
            } else {
              onChange({ $result: v });
            }
          }}
        >
          {options.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
          <option value="__custom__">Custom…</option>
        </Select>
      </PropRow>
      {isCustom && (
        <PropRow label="Field name">
          <input
            className="cfg-prop-input"
            type="text"
            value={field}
            onChange={(e) => onChange({ $result: e.target.value })}
            placeholder="e.g. reason"
          />
        </PropRow>
      )}
    </div>
  );
}
