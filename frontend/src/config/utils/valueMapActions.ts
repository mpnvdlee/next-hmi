import { useConfigStore } from '@shared/store/configStore';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { makeValueMapNodeId } from '@shared/constants/editorSentinels';

// What the tree's menu and the value-map panel do to a project value map.

/** The first of `base`, `base-2`, `base-3`, … no value map has yet. */
function freeId(base: string): string {
  const taken = new Set(useConfigStore.getState().valueMaps.map((m) => m.id));
  let n = 1;
  while (taken.has(n === 1 ? base : `${base}-${n}`)) n++;
  return n === 1 ? base : `${base}-${n}`;
}

export const select = (id: string | null) => useEditorDomainStore.getState().setSelected(id);

/** Append an empty String map, `map-N`, and select it. */
export function addValueMap(): void {
  const { valueMaps, updateValueMaps } = useConfigStore.getState();
  let n = valueMaps.length + 1;
  while (valueMaps.some((m) => m.id === `map-${n}`)) n++;
  const id = `map-${n}`;
  updateValueMaps([...valueMaps, { id, type: 'String', cases: [], default: '' }]);
  select(makeValueMapNodeId(id));
}

/** Insert a copy of map `id`, `id-copy`, right after it and select the copy. */
export function duplicateValueMap(id: string): void {
  const { valueMaps, updateValueMaps } = useConfigStore.getState();
  const index = valueMaps.findIndex((m) => m.id === id);
  if (index === -1) return;
  const copy = { ...structuredClone(valueMaps[index]), id: freeId(`${id}-copy`) };
  updateValueMaps([...valueMaps.slice(0, index + 1), copy, ...valueMaps.slice(index + 1)]);
  select(makeValueMapNodeId(copy.id));
}

/** Remove map `id`; undo brings it back. */
export function deleteValueMap(id: string): void {
  const { valueMaps, updateValueMaps } = useConfigStore.getState();
  updateValueMaps(valueMaps.filter((m) => m.id !== id));
  if (useEditorDomainStore.getState().selectedId === makeValueMapNodeId(id)) select(null);
}

/** Rename map `from` and every `$map` reading it, then keep it selected. */
export async function renameValueMap(from: string, to: string): Promise<void> {
  const wasSelected = useEditorDomainStore.getState().selectedId === makeValueMapNodeId(from);
  if ((await useConfigStore.getState().renameValueMap(from, to)) && wasSelected) {
    select(makeValueMapNodeId(to.trim()));
  }
}
