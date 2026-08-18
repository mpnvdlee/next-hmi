import type { WidgetConfig } from '@shared/types/config';

/** Slot name used when a `ComponentSlot` leaves its `slot` property blank, and
 *  the slot an instance's untagged children fall into. */
export const DEFAULT_SLOT_KEY = 'content';

/** Normalise a raw `slot` property value to a usable slot name. */
export function slotKeyOf(raw: unknown): string {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : DEFAULT_SLOT_KEY;
}

/** Title-case a slot key for the editor tree's section row ("body" → "Body"). */
export function slotLabel(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** How every editor surface names one slot of one instance: the widget tree's
 *  sections, the Move dialog's targets, the preview's insert target. */
export function slotTargetLabel(widgetName: string, slot: string): string {
  return `${widgetName} / ${slotLabel(slot)}`;
}

/** The slot a child of an instance fills. An untagged child — or one tagged with
 *  a slot the definition no longer has — falls into the first slot, so trimming
 *  a definition never makes content vanish. Returns `undefined` only when the
 *  definition declares no slots at all. */
export function resolveChildSlot(tag: string | undefined, slots: string[]): string | undefined {
  return tag !== undefined && slots.includes(tag) ? tag : slots[0];
}

/** Walk a definition's widget tree for `ComponentSlot` nodes, collecting their
 *  slot names in tree order. Duplicates collapse: two slots sharing a name are
 *  one slot rendered twice, which is a legitimate (if odd) definition. */
export function collectSlotKeys(nodes: WidgetConfig[] | undefined, out: string[] = []): string[] {
  for (const node of nodes ?? []) {
    if (node.type === 'ComponentSlot') {
      const key = slotKeyOf(node.properties?.slot);
      if (!out.includes(key)) out.push(key);
    }
    collectSlotKeys(node.children, out);
  }
  return out;
}

/** Group an instance's authored children by the slot they fill, per
 *  {@link resolveChildSlot}. */
export function groupChildrenBySlot(
  children: WidgetConfig[] | undefined,
  slots: string[],
): Record<string, WidgetConfig[]> {
  const grouped: Record<string, WidgetConfig[]> = {};
  for (const key of slots) grouped[key] = [];
  if (slots.length === 0) return grouped;
  for (const child of children ?? []) {
    // `resolveChildSlot` matches against the declared list, so a child tagged
    // `toString` or `constructor` cannot resolve to an inherited prototype
    // member and blow up on the push below.
    grouped[resolveChildSlot(child.slot, slots)!].push(child);
  }
  return grouped;
}
