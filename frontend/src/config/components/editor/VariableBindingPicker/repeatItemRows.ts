import type { ComponentPropertySchema, StructSchemaNode } from '@shared/types/componentProperty';
import {
  accepts,
  formatVarType,
  parseTypeToken,
  structSatisfies,
  type StructMember,
  type VarType,
} from '@shared/types/varType';
import { acceptedValueTypes } from '@shared/utils/valueTypes';
import type { RequiredFieldEntry } from '@shared/types/widgetSchema';
import type {
  PickerFolderEntry,
  PickerVariableEntry,
} from '@config/components/ui/datasourceTreeHelpers';
import { memberLookup } from './helpers';
import type {
  RepeatItemPick,
  RepeatItemPickerOptions,
} from '@config/store/domains/editorDomainStore';

/** Row keys of the Repeat item group. `#` never starts a datasource name, so
 *  these cannot collide with a `datasource:path` variable key. */
export const REPEAT_KEY_PREFIX = '#repeat:';
export const REPEAT_SOURCE_KEY = 'source:repeatItem';
/** Typed after a path, stands for the surrounding Repeater copy's index —
 *  the way `[2]` stands for element 2. */
export const REPEAT_INDEX_SUFFIX = '[#]';
const ELEMENT = 'element';
const INDEX = 'index';

export function isRepeatKey(key: string | null): key is string {
  return !!key?.startsWith(REPEAT_KEY_PREFIX);
}

export function repeatPickKey(pick: RepeatItemPick): string {
  if (pick.field === 'index') return `${REPEAT_KEY_PREFIX}${INDEX}`;
  return `${REPEAT_KEY_PREFIX}${ELEMENT}${pick.member ? `/${pick.member}` : ''}`;
}

export function repeatPickFromKey(key: string): RepeatItemPick | null {
  if (!isRepeatKey(key)) return null;
  const rest = key.slice(REPEAT_KEY_PREFIX.length);
  if (rest === INDEX) return { field: 'index' };
  if (rest === ELEMENT) return { field: 'value' };
  if (rest.startsWith(`${ELEMENT}/`)) {
    return { field: 'value', member: rest.slice(ELEMENT.length + 1) };
  }
  return null;
}

/** How a pick reads in a field: `Repeat item › Speed`. */
export function repeatPickLabel(pick: RepeatItemPick): string {
  if (pick.field === 'index') return 'Repeat item › Index';
  return pick.member ? `Repeat item › ${pick.member}` : 'Repeat item › Element';
}

/** Whether a key can be confirmed. A write target names one variable: a struct
 *  element is written a member at a time, and the index is not writable. */
export function isPickableRepeatKey(key: string, options: RepeatItemPickerOptions): boolean {
  const pick = repeatPickFromKey(key);
  if (!pick) return false;
  if (!options.writeTarget) return true;
  if (!options.scope.writable || pick.field === 'index') return false;
  return !!pick.member || !options.scope.members?.length;
}

/** What the field being bound takes — the picker's filter. */
export interface PickerFieldType {
  type?: string | string[];
  write?: boolean;
  requiredFields?: RequiredFieldEntry[];
}

/**
 * Whether a pick fits the field — the same rule the drawer's ✓/✗ and its
 * type filter apply to a variable. A type only the runtime knows is taken on
 * trust.
 */
export function repeatPickFits(
  pick: RepeatItemPick,
  options: RepeatItemPickerOptions,
  field: PickerFieldType | null,
): boolean {
  const { scope } = options;
  if (field?.write && !repeatPickWritable(pick, scope)) return false;
  const allowed = field?.type !== undefined ? acceptedValueTypes(field.type) : [];
  const type = repeatPickVarType(pick, scope);
  if (allowed.length === 0 || !type) return true;
  const required = field?.requiredFields;
  if (!allowed.some((t) => accepts(parseTypeToken(t), type, required))) return false;
  if (type.kind !== 'struct' || !required?.length) return true;
  const { fields, folders } = repeatPickMembers(pick, type, scope);
  return structSatisfies(required, memberLookup(fields, folders));
}

/** Whether a pick can be written: the index never; a member only when the
 *  metadata says it is writable — a struct member is judged by its own members,
 *  and one the metadata does not list is not judged, as the validator skips
 *  it; otherwise as the element is. */
function repeatPickWritable(
  pick: RepeatItemPick,
  scope: RepeatItemPickerOptions['scope'],
): boolean {
  if (pick.field === 'index' || !scope.writable) return false;
  const info = pick.member ? scope.memberInfo?.[pick.member] : undefined;
  if (!info) return true;
  return info.type?.kind === 'struct' || info.writable === true;
}

/** A struct element's members as struct-schema nodes; a member whose type only
 *  the runtime knows has none, so no required type is held against it. */
function memberNodes(
  scope: RepeatItemPickerOptions['scope'],
  members: readonly string[],
): StructSchemaNode[] {
  return members.map((name) => {
    const info = scope.memberInfo?.[name];
    return {
      kind: 'variable' as const,
      name,
      type: info?.type ? formatVarType(info.type) : scope.memberTypes?.[name],
      write: repeatPickWritable({ field: 'value', member: name }, scope),
    };
  });
}

/**
 * The copy's element as a component-property tree, so the picker draws it with
 * the rows it already has for component properties: the element (with a child
 * row per member) and its index. `fits` narrows it to what the field takes; the
 * element stays while any of its members does, the way a struct property does.
 */
export function repeatItemProperties(
  options: RepeatItemPickerOptions,
  fits: (pick: RepeatItemPick) => boolean = () => true,
): Record<string, ComponentPropertySchema> {
  const { scope, writeTarget } = options;
  const members = (scope.members ?? []).filter((member) => fits({ field: 'value', member }));
  const props: Record<string, ComponentPropertySchema> = {};
  if (fits({ field: 'value' }) || members.length > 0) {
    props[ELEMENT] = {
      label: 'Element',
      type: scope.elementType ?? (scope.members?.length ? 'Struct' : 'Any'),
      write: scope.writable,
      ...(members.length && { structSchema: memberNodes(scope, members) }),
    };
  }
  if (!writeTarget && fits({ field: 'index' })) {
    props[INDEX] = { label: 'Index', type: 'Integer', write: false };
  }
  return props;
}

/** The type a pick reads, as far as the scope knows it. `null` when only the
 *  runtime knows — an API response's members. */
export function repeatPickVarType(
  pick: RepeatItemPick,
  scope: RepeatItemPickerOptions['scope'],
): VarType | null {
  if (pick.field === 'index') return { kind: 'scalar', base: 'Integer', array: false };
  if (pick.member && scope.memberInfo) return scope.memberInfo[pick.member]?.type ?? null;
  const token = pick.member ? scope.memberTypes?.[pick.member] : scope.elementType;
  if (!pick.member && scope.members?.length) {
    return { kind: 'struct', name: token ?? 'Struct', fields: scope.members, array: false };
  }
  if (!token) return null;
  const parsed = parseTypeToken(token);
  return parsed.kind === 'scalar' && parsed.base
    ? { kind: 'scalar', base: parsed.base, array: false }
    : null;
}

interface RepeatPickMembers {
  fields: Record<string, PickerVariableEntry>;
  folders: Record<string, PickerFolderEntry>;
}

/**
 * The members a struct pick offers, as the variables and sub-folders of a
 * picker folder — what the drawer's Required panel and `repeatPickFits` both
 * judge. Read off the variable metadata where the element is a variable (full
 * types, each member's access, nested structs); otherwise every listed member,
 * with the type the scope names and the element's access.
 */
export function repeatPickMembers(
  pick: RepeatItemPick,
  type: VarType | null,
  scope: RepeatItemPickerOptions['scope'],
): RepeatPickMembers {
  if (type?.kind !== 'struct') return { fields: {}, folders: {} };
  if (scope.memberInfo) {
    return membersFromInfo(scope.memberInfo, type.fields, pick.member ? `${pick.member}/` : '');
  }
  return {
    fields: Object.fromEntries(
      type.fields.map((name) => [
        name,
        {
          display_name: name,
          data_type: scope.memberTypes?.[name] ?? '',
          writable: scope.writable,
        } as PickerVariableEntry,
      ]),
    ),
    folders: {},
  };
}

function membersFromInfo(
  info: Record<string, StructMember>,
  names: readonly string[],
  prefix: string,
): RepeatPickMembers {
  const fields: Record<string, PickerVariableEntry> = {};
  const folders: Record<string, PickerFolderEntry> = {};
  for (const name of names) {
    const member = info[`${prefix}${name}`];
    const type = member?.type;
    if (!member) continue;
    if (type?.kind === 'struct') {
      const nested = type.array
        ? { fields: {}, folders: {} }
        : membersFromInfo(info, type.fields, `${prefix}${name}/`);
      folders[name] = {
        kind: 'folder',
        name,
        is_array: type.array,
        children: [...Object.values(nested.fields), ...Object.values(nested.folders)],
      };
    } else {
      fields[name] = {
        kind: 'variable',
        display_name: name,
        data_type: type?.base ?? '',
        is_array: type?.array,
        writable: member.writable,
      } as PickerVariableEntry;
    }
  }
  return { fields, folders };
}
