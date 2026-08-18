import { create } from 'zustand';
import type {
  DialogConfig,
  GlobalEventsConfig,
  PageNode,
  ShellConfig,
  WidgetConfig,
} from '../types/config';
import type { ComponentDefinition } from '../types/componentTypes';
import { useConfigStore } from './configStore';
import { useTranslationStore } from './translationStore';
import { useComponentStore, saveComponentDrafts } from './componentStore';
import { errorMessage } from '../utils/api';

const MAX_HISTORY = 50;

const SAVE_AREA_LABELS: Record<string, string> = {
  components: 'Components',
  alarms: 'Alarms',
  recipes: 'Recipes',
  historian: 'Historian',
  theme: 'Themes',
};

/** Turns a `registerSave` key into wording an operator can act on. */
function saveAreaLabel(key: string): string {
  if (key.startsWith('ds-vars-')) return `Variables of "${key.slice('ds-vars-'.length)}"`;
  if (key.startsWith('ds-props-')) return `Settings of "${key.slice('ds-props-'.length)}"`;
  return SAVE_AREA_LABELS[key] ?? key;
}

interface Snapshot {
  pages: PageNode[];
  header: WidgetConfig[];
  footer: WidgetConfig[];
  leftSidebar: WidgetConfig[];
  rightSidebar: WidgetConfig[];
  shell: ShellConfig;
  dialogs: DialogConfig[];
  globalEvents: GlobalEventsConfig;
  translationLanguages: Array<{ code: string }>;
  translations: Record<string, Record<string, string>>;
  draftComponents: Record<string, ComponentDefinition>;
  /** Per-store extra payloads contributed by registered snapshot extensions. */
  extras: Record<string, unknown>;
}

/**
 * Lets a store outside this module (e.g. the theme editor) take part in
 * undo/redo without projectStore importing it — mirrors `registerSave`, and
 * avoids the circular import that a direct dependency would create.
 */
interface SnapshotExtension {
  capture(): unknown;
  restore(data: unknown): void;
}

interface ProjectStore {
  dirty: boolean;
  saving: boolean;
  /** What went wrong in the last save, ready to show, or null when it worked. */
  saveError: string | null;

  past: Snapshot[];
  future: Snapshot[];

  markDirty(): void;
  pushSnapshot(): void;
  /** Run a composite edit as one undo step: the snapshot is taken up front and
   *  the store actions it calls push none of their own. */
  runBatched(fn: () => void): void;
  undo(): void;
  redo(): void;

  /** Monotonic counter bumped on every edit that dirties the project. saveAll
   *  captures it before its async writes and only clears `dirty` if it hasn't
   *  changed — an edit made mid-save must not be cleared. */
  _dirtySeq: number;

  _saveCallbacks: Map<string, () => Promise<void>>;
  registerSave(key: string, fn: () => Promise<void>): void;
  unregisterSave(key: string): void;
  saveAll(): Promise<void>;
  dismissSaveError(): void;

  _snapshotExtensions: Map<string, SnapshotExtension>;
  registerSnapshotExtension(key: string, ext: SnapshotExtension): void;
  unregisterSnapshotExtension(key: string): void;
}

function captureSnapshot(): Snapshot {
  const c = useConfigStore.getState();
  const extras: Record<string, unknown> = {};
  for (const [key, ext] of useProjectStore.getState()._snapshotExtensions) {
    extras[key] = ext.capture();
  }
  return {
    pages: structuredClone(c.pages),
    header: structuredClone(c.header),
    footer: structuredClone(c.footer),
    leftSidebar: structuredClone(c.leftSidebar),
    rightSidebar: structuredClone(c.rightSidebar),
    shell: structuredClone(c.shell),
    dialogs: structuredClone(c.dialogs),
    globalEvents: structuredClone(c.globalEvents),
    translationLanguages: structuredClone(useTranslationStore.getState().languages),
    translations: structuredClone(useTranslationStore.getState().translations),
    draftComponents: structuredClone(useComponentStore.getState().draftComponents),
    extras,
  };
}

function restoreSnapshot(snapshot: Snapshot) {
  const c = useConfigStore.getState();
  c.setPages(structuredClone(snapshot.pages));
  c.setHeader(structuredClone(snapshot.header));
  c.setFooter(structuredClone(snapshot.footer));
  c.setLeftSidebar(structuredClone(snapshot.leftSidebar));
  c.setRightSidebar(structuredClone(snapshot.rightSidebar));
  c.setShell(structuredClone(snapshot.shell));
  c.setDialogs(structuredClone(snapshot.dialogs));
  c.setGlobalEvents(structuredClone(snapshot.globalEvents));
  useTranslationStore.setState({
    languages: structuredClone(snapshot.translationLanguages),
    translations: structuredClone(snapshot.translations),
  });
  useComponentStore.getState().restoreDrafts(structuredClone(snapshot.draftComponents));
  for (const [key, ext] of useProjectStore.getState()._snapshotExtensions) {
    if (key in snapshot.extras) ext.restore(snapshot.extras[key]);
  }
}

/** Set while a `runBatched` edit is in flight so the store actions it composes
 *  don't each push their own snapshot. */
let batching = false;

export const useProjectStore = create<ProjectStore>((set, get) => ({
  dirty: false,
  saving: false,
  saveError: null,
  _dirtySeq: 0,

  past: [],
  future: [],

  markDirty: () => set((s) => ({ dirty: true, _dirtySeq: s._dirtySeq + 1 })),

  pushSnapshot: () => {
    if (batching) return;
    const snapshot = captureSnapshot();
    set((s) => ({
      past: [...s.past.slice(-(MAX_HISTORY - 1)), snapshot],
      future: [],
    }));
  },

  runBatched: (fn) => {
    if (batching) {
      fn();
      return;
    }
    get().pushSnapshot();
    // The composed actions write through `set` rather than calling each other,
    // so the batch owns the dirty flag the way a single edit's snapshot does.
    get().markDirty();
    batching = true;
    try {
      fn();
    } finally {
      batching = false;
    }
  },

  undo: () => {
    const { past } = get();
    if (past.length === 0) return;
    const current = captureSnapshot();
    const prev = past[past.length - 1];
    restoreSnapshot(prev);
    set((s) => ({
      past: s.past.slice(0, -1),
      future: [current, ...s.future],
      dirty: true,
      _dirtySeq: s._dirtySeq + 1,
    }));
  },

  redo: () => {
    const { future } = get();
    if (future.length === 0) return;
    const current = captureSnapshot();
    const next = future[0];
    restoreSnapshot(next);
    set((s) => ({
      past: [...s.past, current],
      future: s.future.slice(1),
      dirty: true,
      _dirtySeq: s._dirtySeq + 1,
    }));
  },

  _saveCallbacks: new Map([['components', saveComponentDrafts]]),

  registerSave: (key, fn) => {
    get()._saveCallbacks.set(key, fn);
  },

  unregisterSave: (key) => {
    get()._saveCallbacks.delete(key);
  },

  _snapshotExtensions: new Map(),

  registerSnapshotExtension: (key, ext) => {
    get()._snapshotExtensions.set(key, ext);
  },

  unregisterSnapshotExtension: (key) => {
    get()._snapshotExtensions.delete(key);
  },

  dismissSaveError: () => set({ saveError: null }),

  saveAll: async () => {
    set({ saving: true, saveError: null });
    // Capture the dirty counter before any await. If an edit lands during the
    // async save window it bumps the counter, and we must not clear `dirty`.
    const dirtySeqAtStart = get()._dirtySeq;
    const start = Date.now();
    const MIN_SAVE_MS = 600;
    const pad = () => {
      const elapsed = Date.now() - start;
      return elapsed < MIN_SAVE_MS
        ? new Promise<void>((r) => setTimeout(r, MIN_SAVE_MS - elapsed))
        : Promise.resolve();
    };
    const fail = async (message: string) => {
      await pad();
      set({ saving: false, saveError: message });
    };

    // Save runtime config first (other saves may depend on valid config)
    const configSaved = await useConfigStore.getState().saveConfigToBackend();
    if (!configSaved) {
      const reason = useConfigStore.getState().saveError;
      await fail(`Pages & layout: ${reason ?? 'unknown error'}`);
      return;
    }

    // Save translations and all registered callbacks in parallel. allSettled,
    // not all: every failing area has to be named, and one rejection must not
    // leave the others' rejections unhandled.
    const entries = Array.from(get()._saveCallbacks.entries());
    const results = await Promise.allSettled([
      useTranslationStore
        .getState()
        .saveTranslations()
        .then((ok) => {
          if (!ok) {
            throw new Error(
              useTranslationStore.getState().error ?? 'translations could not be saved',
            );
          }
        }),
      ...entries.map(([, fn]) => fn()),
    ]);

    const failures: string[] = [];
    results.forEach((result, i) => {
      if (result.status !== 'rejected') return;
      const label = i === 0 ? 'Translations' : saveAreaLabel(entries[i - 1][0]);
      console.error(`[projectStore] saveAll failed (${label}):`, result.reason);
      failures.push(`${label}: ${errorMessage(result.reason)}`);
    });

    if (failures.length > 0) {
      await fail(failures.join(' · '));
      return;
    }

    await pad();
    set((s) => ({
      // Keep dirty if an edit landed mid-save — its change wasn't in this pass.
      dirty: s._dirtySeq !== dirtySeqAtStart,
      saving: false,
    }));
  },
}));
