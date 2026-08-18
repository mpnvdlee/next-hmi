/**
 * The nodes waiting to be moved by the next paste.
 *
 * Cut writes the same JSON to the system clipboard that Copy does — so a paste
 * in another editor, or another tab, still works and still clones — and records
 * the source ids here. A paste that finds those ids still present in the project it
 * is pasting into moves the nodes instead of cloning them, keeping their ids.
 */

import { create } from 'zustand';
import type { ClipboardNode, ClipboardNodeKind } from './clipboardOps';

interface CutState {
  /** All cut nodes share one kind — a multi-selection is always widgets. */
  cut: { nodeIds: ReadonlySet<string>; kind: ClipboardNodeKind } | null;
  setCut: (nodeIds: string[], kind: ClipboardNodeKind) => void;
  clearCut: () => void;
}

export const useCutStore = create<CutState>((set) => ({
  cut: null,
  setCut: (nodeIds, kind) => set({ cut: { nodeIds: new Set(nodeIds), kind } }),
  clearCut: () => set((s) => (s.cut ? { cut: null } : s)),
}));

export const setCut = (nodeIds: string[], kind: ClipboardNodeKind): void =>
  useCutStore.getState().setCut(nodeIds, kind);

export const clearCut = (): void => useCutStore.getState().clearCut();

export const pendingCut = (): CutState['cut'] => useCutStore.getState().cut;

/** Whether a clipboard payload is exactly the pending cut: the same ids, all of
 *  them, of the cut's kind. The store is shared by both editors and a paste
 *  clears it, so a partial match would move some nodes and drop the rest.
 *  Whether those nodes are still present is asked separately, by the editor
 *  pasting them — this predicate is project-agnostic. */
export function matchesPendingCut(nodes: readonly ClipboardNode[]): boolean {
  const cut = pendingCut();
  if (!cut) return false;
  if (nodes.length !== cut.nodeIds.size) return false;
  return nodes.every((n) => n.kind === cut.kind && cut.nodeIds.has(n.node.id));
}

/** True while this row is part of the pending cut, so it can render dimmed. */
export function useIsCut(nodeId: string): boolean {
  return useCutStore((s) => s.cut?.nodeIds.has(nodeId) ?? false);
}
