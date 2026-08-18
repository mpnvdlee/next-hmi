import { createContext, useContext } from 'react';
import type { SelectionModifiers } from '@shared/utils/domEvent';

/**
 * Selection context shared by every component-tree row (TreeNode + the page/
 * dialog/page-group wrappers used by the editor). Wrapping a tree with
 * `TreeSelectionContext.Provider` lets the same row components be reused in
 * both the page editor (selection lives in editorDomainStore) and the widgets
 * editor (selection lives in componentEditorStore).
 */
interface TreeSelectionContextValue {
  /** A Set rather than an array: every widget row membership-tests it on each render. */
  selectedIds: ReadonlySet<string>;
  /** A row click carrying its modifiers — plain replaces, toggle adds or removes,
   *  range extends from the anchor. */
  selectRow: (id: string, mods: SelectionModifiers) => void;
}

export const TreeSelectionContext = createContext<TreeSelectionContextValue | null>(null);

export function useTreeSelection(): TreeSelectionContextValue {
  const ctx = useContext(TreeSelectionContext);
  if (!ctx) {
    throw new Error('useTreeSelection must be used inside <TreeSelectionContext.Provider>');
  }
  return ctx;
}
