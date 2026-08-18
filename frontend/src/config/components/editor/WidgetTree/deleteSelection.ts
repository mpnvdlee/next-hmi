import { useConfigStore } from '@shared/store/configStore';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';

/**
 * Delete widgets and leave the selection pointing only at rows the tree still has.
 *
 * Deleting a container takes its descendants with it, so a selected child is gone
 * even though it never appeared in `targets` — the delete reports those ids, which
 * is what separates them from ids that were never widgets to begin with (a section
 * or shell sentinel row), which stay selected. `setSelectedMany` drops the lead when
 * nothing survives. Shared by the tree and the live preview, whose delete verbs are
 * the same action from two panels.
 */
export function deleteWidgetsKeepingSelection(targets: string[]): void {
  const editor = useEditorDomainStore.getState();
  const removed = useConfigStore.getState().deleteComponents(targets);
  const survivors = editor.selectedIds.filter((id) => !removed.has(id));
  if (survivors.length !== editor.selectedIds.length) editor.setSelectedMany(survivors);
}
