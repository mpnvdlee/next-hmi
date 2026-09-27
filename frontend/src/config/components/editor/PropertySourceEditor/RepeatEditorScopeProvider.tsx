import { useMemo, useRef, type ReactNode } from 'react';
import { getVarBinding, isRecord } from '@shared/types/propertyValueGuards';
import { useVariableStore } from '@hmi/store/variableStore';
import { structShapeElementPath } from '@hmi/utils/repeatItemResolution';
import { listItemTypes, type StructMember } from '@shared/types/varType';
import { repeatItemsKey } from '@shared/utils/parentFlow';
import { RepeatEditorScopeContext, type RepeatEditorScope } from './repeatScopeContext';

const RECORD_MEMBERS = ['label', 'value'];
const STRING_RECORD = { label: 'String', value: 'String' };
type VarMetaMap = ReturnType<typeof useVariableStore.getState>['varMeta'];
const NO_META: VarMetaMap = {};

/** Every member below `base` the metadata knows, by its path below it, walking
 *  into nested structs — not into nested struct arrays, whose members sit a
 *  level deeper, under an element. */
function collectMembers(
  varMeta: VarMetaMap,
  base: string,
  fields: readonly string[],
  prefix = '',
  out: Record<string, StructMember> = {},
): Record<string, StructMember> {
  for (const field of fields) {
    const meta = varMeta[`${base}/${prefix}${field}`];
    if (!meta) continue;
    out[`${prefix}${field}`] = { type: meta.type, writable: meta.writable };
    if (meta.type.kind === 'struct' && !meta.type.array) {
      collectMembers(varMeta, base, meta.type.fields, `${prefix}${field}/`, out);
    }
  }
  return out;
}

/**
 * The innermost widget declaring `repeatsChildren` that encloses `id` anywhere
 * in `roots` — any nesting of arrays and objects whose widget nodes carry `id`
 * and `type`, so pages, shell areas, dialogs and component definitions all walk
 * the same way.
 */
function findRepeaterAncestor(roots: unknown, id: string): Record<string, unknown> | null {
  const stack: Record<string, unknown>[] = [];
  let hit: Record<string, unknown> | null | undefined;
  const walk = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.some(walk);
    if (!isRecord(node)) return false;
    const isWidget = typeof node.id === 'string' && typeof node.type === 'string';
    if (isWidget && node.id === id) {
      hit = [...stack].reverse().find((n) => repeatItemsKey(String(n.type)) !== null) ?? null;
      return true;
    }
    if (isWidget) stack.push(node);
    const found = Object.values(node).some(walk);
    if (isWidget) stack.pop();
    return found;
  };
  walk(roots);
  return hit ?? null;
}

/**
 * The element of a literal list, typed by its values (`listItemTypes`) as the
 * validator types it. An empty one offers the `{ label, value }` members the
 * list editor writes, their types not known yet.
 */
function literalListScope(list: unknown[]): RepeatEditorScope {
  if (list.length === 0) return { members: RECORD_MEMBERS, writable: false, elementType: 'Struct' };
  const { element, members } = listItemTypes(list);
  if (!element) return { members: null, writable: false };
  if (element.kind === 'scalar') return { members: [], writable: false, elementType: element.base };
  const memberTypes: Record<string, string> = {};
  for (const [name, type] of Object.entries(members)) {
    if (type.kind === 'scalar') memberTypes[name] = type.base;
  }
  return { members: element.fields, writable: false, elementType: 'Struct', memberTypes };
}

export default function RepeatEditorScopeProvider({
  roots,
  rev,
  fallback,
  widgetId,
  children,
}: {
  roots: unknown;
  /** Changes only when the tree's shape does. When given, the walk repeats on
   *  it instead of on every property write — the Repeater's own `items` then
   *  refresh on the next selection, which is when a child is picked anyway. */
  rev?: unknown;
  /** Scope to offer when no Repeater encloses the widget — a component
   *  definition, whose instances may each be placed inside one. */
  fallback?: RepeatEditorScope;
  widgetId: string;
  children: ReactNode;
}) {
  const rootsRef = useRef(roots);
  rootsRef.current = roots;
  const repeater = useMemo(
    () => findRepeaterAncestor(rootsRef.current, widgetId),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rev stands for the tree the ref reads
    [rev === undefined ? roots : rev, widgetId],
  );
  const itemsKey = repeater ? repeatItemsKey(String(repeater.type)) : null;
  const items =
    itemsKey && isRecord(repeater?.properties) ? repeater.properties[itemsKey] : undefined;
  const arrayKey = getVarBinding(items)?.path ?? '';
  // A static or user list never reads the metadata; it must not rebuild the scope on it.
  const varMeta = useVariableStore((s) => (arrayKey ? s.varMeta : NO_META));
  const type = arrayKey ? varMeta[arrayKey]?.type : undefined;

  const value = useMemo((): RepeatEditorScope | null => {
    if (!repeater) return fallback ?? null;
    if (arrayKey) {
      if (type?.kind !== 'struct') {
        const meta = varMeta[arrayKey];
        return {
          members: [],
          // Unset access is read-only; a variable the metadata does not list
          // yet is not judged, as the validator skips it.
          writable: meta ? meta.writable === true : true,
          elementType: type?.base,
        };
      }
      const element = structShapeElementPath(varMeta, arrayKey);
      const memberTypes: Record<string, string> = {};
      for (const field of type.fields) {
        const leaf = element ? varMeta[`${element}/${field}`]?.type : undefined;
        if (leaf?.kind === 'scalar') memberTypes[field] = leaf.base;
      }
      return {
        members: type.fields,
        writable: true,
        elementType: type.name || 'Struct',
        memberTypes,
        ...(element && { memberInfo: collectMembers(varMeta, element, type.fields) }),
      };
    }
    if (Array.isArray(items)) return literalListScope(items);
    if (isRecord(items) && Array.isArray(items.$static)) return literalListScope(items.$static);
    return isRecord(items) && '$user' in items
      ? {
          members: RECORD_MEMBERS,
          writable: false,
          elementType: 'Struct',
          memberTypes: STRING_RECORD,
        }
      : { members: null, writable: false };
  }, [repeater, arrayKey, type, varMeta, items, fallback]);

  return (
    <RepeatEditorScopeContext.Provider value={value}>{children}</RepeatEditorScopeContext.Provider>
  );
}
