/**
 * The one place `selectedId` / `selectedIds` / `selectionAnchorId` are derived from
 * each other, so the "lead is the last entry" invariant cannot drift — not between
 * actions, and not between the page editor's store and the components editor's.
 * Each store layers whatever else its selection carries on top of these three.
 */
export function selectionFields(
  ids: string[],
  anchorId: string | null,
): { selectedIds: string[]; selectedId: string | null; selectionAnchorId: string | null } {
  const unique = [...new Set(ids)];
  const last = unique.length > 0 ? unique[unique.length - 1] : null;
  return {
    selectedIds: unique,
    selectedId: last,
    selectionAnchorId: last === null ? null : anchorId,
  };
}
