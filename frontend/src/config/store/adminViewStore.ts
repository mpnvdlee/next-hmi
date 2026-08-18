import { create, type StoreApi } from 'zustand';
import { apiJson } from '@shared/utils/api';
import type { CustomWidgetManifestEntry } from '@shared/types/widgetSchema';

export interface SubscriptionEntry {
  priority_paths: string[];
  priority_leaf_paths: string[];
  connected: boolean;
  bg_enabled: boolean;
}

/** The build-status half of a `/api/widgets` row — all the admin panel reads. */
export type CustomWidgetStatus = Pick<
  CustomWidgetManifestEntry,
  'key' | 'name' | 'group' | 'hasStyle' | 'buildOk' | 'buildError' | 'buildTs' | 'schemaError'
>;

/** Canonical widget identity supplied by the compiler/status API. */
export function customWidgetKey(w: Pick<CustomWidgetStatus, 'key'>): string {
  return w.key;
}

export interface RuntimeSession {
  clientId: string;
  scope: string;
  username: string;
  groups: string[];
  connectedAt: string;
}

interface AdminViewStore {
  customWidgets: CustomWidgetStatus[];
  subscriptions: Record<string, SubscriptionEntry>;
  alarmTriggers: Record<string, string[]>;
  historianPaths: Record<string, string[]>;
  runtimes: RuntimeSession[];
  runtimesLoading: boolean;
  runtimesError: string | null;
  /** Registry keys currently recompiling; `'*'` means the whole "Recompile all" run. */
  recompiling: string[];
  recompileError: string | null;

  loadCustomWidgets(): Promise<void>;
  loadSubscriptions(): Promise<void>;
  loadRuntimes(): Promise<void>;
  recompileAllWidgets(): Promise<void>;
  recompileWidget(key: string): Promise<void>;
}

async function runRecompile(
  set: StoreApi<AdminViewStore>['setState'],
  marker: string,
  url: string,
): Promise<void> {
  set((s) => ({ recompiling: [...s.recompiling, marker], recompileError: null }));
  try {
    set({ customWidgets: await apiJson<CustomWidgetStatus[]>(url, { method: 'POST' }) });
  } catch (e) {
    console.error('[adminViewStore] recompile failed:', e);
    set({ recompileError: String(e) });
  } finally {
    set((s) => ({ recompiling: s.recompiling.filter((k) => k !== marker) }));
  }
}

export const useAdminViewStore = create<AdminViewStore>((set) => ({
  customWidgets: [],
  subscriptions: {},
  alarmTriggers: {},
  historianPaths: {},
  runtimes: [],
  runtimesLoading: false,
  runtimesError: null,
  recompiling: [],
  recompileError: null,

  loadCustomWidgets: async () => {
    try {
      set({ customWidgets: await apiJson<CustomWidgetStatus[]>('/api/widgets') });
    } catch (e) {
      console.error('[adminViewStore] loadCustomWidgets failed:', e);
    }
  },

  loadSubscriptions: async () => {
    try {
      const [subs, trigs, histPaths] = await Promise.all([
        apiJson<Record<string, SubscriptionEntry>>('/api/system/subscriptions'),
        apiJson<Record<string, string[]>>('/api/system/alarm-triggers'),
        apiJson<Record<string, string[]>>('/api/system/historian-paths'),
      ]);
      set({ subscriptions: subs, alarmTriggers: trigs, historianPaths: histPaths });
    } catch (e) {
      console.error('[adminViewStore] loadSubscriptions failed:', e);
    }
  },

  loadRuntimes: async () => {
    set({ runtimesLoading: true, runtimesError: null });
    try {
      const data = await apiJson<{ runtimes: RuntimeSession[] }>('/api/system/runtimes');
      set({ runtimes: data.runtimes, runtimesLoading: false });
    } catch (e) {
      console.error('[adminViewStore] loadRuntimes failed:', e);
      set({ runtimesError: String(e), runtimesLoading: false });
    }
  },

  recompileAllWidgets: () => runRecompile(set, '*', '/api/widgets/recompile'),

  recompileWidget: (key) => {
    const encoded = key.split('/').map(encodeURIComponent).join('/');
    return runRecompile(set, key, `/api/widgets/recompile/${encoded}`);
  },
}));
