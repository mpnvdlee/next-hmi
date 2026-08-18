import { create } from 'zustand';
import { apiJson, errorMessage } from '@shared/utils/api';
import type { ComponentDefinition } from '../types/componentTypes';

interface ComponentStoreState {
  components: ComponentDefinition[];
  folders: string[];
  loaded: boolean;
  loading: boolean;
  draftComponents: Record<string, ComponentDefinition>;
  /** Bumped by every draft write that can change the *shape* of a definition's
   *  widget tree, so a memo over the tree order repeats on this rather than on
   *  every draft write — see `setComponentDraft`. */
  draftStructureRev: number;

  load: () => Promise<void>;
  createComponent: (name: string, group?: string | null) => Promise<ComponentDefinition>;
  createComponentFromDefinition: (component: ComponentDefinition) => Promise<ComponentDefinition>;
  createFolder: (name: string) => Promise<void>;
  deleteFolder: (path: string) => Promise<void>;
  updateComponent: (component: ComponentDefinition) => Promise<ComponentDefinition>;
  deleteComponent: (id: string) => Promise<void>;
  setComponentDraft: (component: ComponentDefinition, change?: DraftChange) => void;
  clearComponentDraft: (id: string) => void;
  /** Put every draft back as an undo/redo snapshot recorded them — structural by
   *  definition, since the drafts it restores are from another point in time. */
  restoreDrafts: (drafts: Record<string, ComponentDefinition>) => void;
}

/** What a draft write did to the definition. `'properties'` promises that no
 *  widget was added, removed or moved — everything else is structural, which is
 *  why it is the default: a write added later over-invalidates (one extra tree
 *  walk) instead of leaving a memo keyed on the revision showing a stale tree. */
export type DraftChange = 'structure' | 'properties';

export const useComponentStore = create<ComponentStoreState>((set, get) => ({
  components: [],
  folders: [],
  loaded: false,
  loading: false,
  draftComponents: {},
  draftStructureRev: 0,

  load: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const [components, folders] = await Promise.all([
        apiJson<ComponentDefinition[]>('/api/components'),
        apiJson<string[]>('/api/components/folders'),
      ]);
      set({ components, folders, loaded: true, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  createComponent: async (name, group = null) => {
    return get().createComponentFromDefinition({
      id: '',
      name,
      group,
      componentProperties: {},
      children: [],
    });
  },

  createComponentFromDefinition: async (component) => {
    // The backend derives a fresh slug id from the name, ignoring the supplied id.
    const created = await apiJson<ComponentDefinition>('/api/components', {
      method: 'POST',
      body: component,
    });
    set((s) => ({ components: [...s.components, created] }));
    return created;
  },

  createFolder: async (name) => {
    await apiJson('/api/components/folders', { method: 'POST', body: { name } });
    // Creating a nested path (e.g. "A/B/C") auto-creates its ancestors on the
    // backend too — add every prefix so the tree doesn't orphan the new leaf.
    const segments = name.split('/');
    const prefixes = segments.map((_, i) => segments.slice(0, i + 1).join('/'));
    set((s) => {
      const next = new Set(s.folders);
      let changed = false;
      for (const p of prefixes) {
        if (!next.has(p)) {
          next.add(p);
          changed = true;
        }
      }
      return changed ? { folders: [...next].sort() } : s;
    });
  },

  deleteFolder: async (path) => {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    await apiJson(`/api/components/folders/${encodedPath}`, { method: 'DELETE' });
    // Deleting a folder cascades to its subfolders and every component inside
    // them on the backend — mirror that in client state.
    set((s) => {
      const isInside = (group: string | null | undefined) =>
        group === path || (!!group && group.startsWith(`${path}/`));
      const deletedIds = new Set(s.components.filter((c) => isInside(c.group)).map((c) => c.id));
      const draftComponents = { ...s.draftComponents };
      for (const id of deletedIds) delete draftComponents[id];
      return {
        folders: s.folders.filter((f) => f !== path && !f.startsWith(`${path}/`)),
        components: s.components.filter((c) => !deletedIds.has(c.id)),
        draftComponents,
      };
    });
  },

  updateComponent: async (component) => {
    const updated = await apiJson<ComponentDefinition>(`/api/components/${component.id}`, {
      method: 'PUT',
      body: component,
    });
    set((s) => ({
      components: s.components.map((c) => (c.id === updated.id ? updated : c)),
    }));
    return updated;
  },

  deleteComponent: async (id) => {
    await apiJson(`/api/components/${id}`, { method: 'DELETE' });
    set((s) => ({
      components: s.components.filter((c) => c.id !== id),
      draftComponents: Object.fromEntries(
        Object.entries(s.draftComponents).filter(([k]) => k !== id),
      ),
    }));
  },

  // The revision rides in the same patch as the draft, so no subscriber can
  // observe one without the other: a separate `setState` would let a memo keyed
  // on the revision recompute against the old draft and cache that answer under
  // the new number.
  setComponentDraft: (component, change = 'structure') =>
    set((s) => ({
      draftComponents: { ...s.draftComponents, [component.id]: component },
      draftStructureRev: change === 'structure' ? s.draftStructureRev + 1 : s.draftStructureRev,
    })),

  clearComponentDraft: (id) =>
    set((s) => {
      const next = { ...s.draftComponents };
      delete next[id];
      return { draftComponents: next };
    }),

  restoreDrafts: (drafts) =>
    set((s) => ({ draftComponents: drafts, draftStructureRev: s.draftStructureRev + 1 })),
}));

/**
 * O(1) component-by-id lookup. A page with many component instances
 * (e.g. 163 copies) would otherwise run one linear `components.find()` per
 * instance on mount and on every store change. The id→component map is built
 * once per `components` array identity (keyed via WeakMap, so it rebuilds only
 * when the array is actually replaced) and shared across all instances.
 */
const byIdCache = new WeakMap<object, Map<string, ComponentDefinition>>();

export function selectComponentById(
  components: ComponentDefinition[],
  id: string,
): ComponentDefinition | undefined {
  let map = byIdCache.get(components);
  if (!map) {
    map = new Map(components.map((c) => [c.id, c]));
    byIdCache.set(components, map);
  }
  return map.get(id);
}

export async function saveComponentDrafts(): Promise<void> {
  const drafts = useComponentStore.getState().draftComponents;
  const errors: Array<{ name: string; error: unknown }> = [];

  for (const draft of Object.values(drafts)) {
    try {
      await useComponentStore.getState().updateComponent(draft);
      useComponentStore.getState().clearComponentDraft(draft.id);
    } catch (err) {
      errors.push({ name: draft.name, error: err });
    }
  }

  if (errors.length > 0) {
    const names = errors.map((e) => e.name).join(', ');
    throw new Error(`${names} — ${errorMessage(errors[0].error)}`);
  }
}
