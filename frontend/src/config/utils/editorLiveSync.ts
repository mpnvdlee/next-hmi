import type { ArtifactType } from '@shared/events/configChangedBus';
import { loadConfigIndex } from '@shared/hooks/useConfig';
import { useComponentStore } from '@shared/store/componentStore';
import { useConfigStore } from '@shared/store/configStore';
import { collectAllIds } from '@shared/store/configStoreHelpers';
import { projectClearHistory } from '@shared/store/projectActions';
import { useProjectStore } from '@shared/store/projectStore';
import { useTranslationStore } from '@shared/store/translationStore';
import { loadAndApplyThemeTokens } from '@shared/utils/themeTokens';
import { useThemeRuntimeStore } from '@hmi/store/themeRuntimeStore';
import { useAlarmConfigStore } from '@config/store/alarmConfigStore';
import { useAdminViewStore } from '@config/store/adminViewStore';
import { useHistorianConfigStore } from '@config/store/historianConfigStore';
import { useRecipeConfigStore } from '@config/store/recipeConfigStore';
import { useThemeViewStore } from '@config/store/themeViewStore';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { useUsersDomainStore } from '@config/store/domains/usersDomainStore';
import { useVariablesDomainStore } from '@config/store/domains/variablesDomainStore';

/** The editor's dirty state: project edits, or the users screen's own draft. */
export function editorHasUnsavedChanges(): boolean {
  return useProjectStore.getState().dirty || useUsersDomainStore.getState().dirty;
}

interface Domain {
  /** Whether this editor holds that content at all. One it never loaded fetches
   *  fresh when its screen opens, so a change to it needs neither a re-fetch
   *  nor a warning — and loading it here would make every later save write it back. */
  held(): boolean;
  /** Re-fetch it. Resolves false when an edit landed meanwhile and the result
   *  was not applied. */
  reload(): Promise<boolean>;
  /** Part of the undo snapshot, so undo could step back over the change. */
  undoable?: true;
}

async function reloadPages(): Promise<boolean> {
  const seq = useProjectStore.getState()._dirtySeq;
  const before = collectAllIds(useConfigStore.getState());
  const applied = await loadConfigIndex(() => useProjectStore.getState()._dirtySeq === seq);
  if (!applied) return false;
  // The other writer may have deleted a selected widget or page: keep the rest.
  // Tabs of a deleted page close by themselves (EditorView).
  const after = collectAllIds(useConfigStore.getState());
  const editor = useEditorDomainStore.getState();
  const kept = editor.selectedIds.filter((id) => !before.has(id) || after.has(id));
  if (kept.length !== editor.selectedIds.length) {
    const anchor = editor.selectionAnchorId;
    editor.setSelectedMany(
      kept,
      editor.selectedRegion,
      anchor && kept.includes(anchor) ? anchor : undefined,
    );
  }
  return true;
}

async function reloadTranslations(): Promise<boolean> {
  const store = useTranslationStore.getState();
  await store.loadDictionaries();
  const { dictionaries, activeDictionary } = useTranslationStore.getState();
  if (dictionaries.length > 0 && !dictionaries.includes(activeDictionary)) {
    // The open dictionary was deleted elsewhere; nothing of it is left to keep.
    useTranslationStore.setState({ activeDictionary: dictionaries[0], loaded: false });
  }
  // Not forced: the store itself drops the result when an edit landed meanwhile.
  await useTranslationStore.getState().loadTranslations();
  return true;
}

const DOMAINS: Partial<Record<ArtifactType, Domain>> = {
  // The index carries every page document, the Dialogs folder, the shell and
  // globalEvents, so one re-fetch covers any page or layout edit.
  page: { held: () => useConfigStore.getState().loaded, reload: reloadPages, undoable: true },
  translations: {
    held: () => useTranslationStore.getState().loaded,
    reload: reloadTranslations,
    undoable: true,
  },
  // Drafts sit beside the saved list, so an edit made meanwhile survives the load.
  component: {
    held: () => useComponentStore.getState().loaded,
    reload: () =>
      useComponentStore
        .getState()
        .load()
        .then(() => true),
    undoable: true,
  },
  // The editor paints the project theme everywhere. The Themes screen's load
  // also refreshes the shared theme cache and paints the theme it shows; it
  // keeps the drafts.
  theme: {
    held: () => true,
    reload: async () => {
      if (useThemeViewStore.getState().themeIds.length > 0) {
        await useThemeViewStore.getState().load();
      } else {
        await loadAndApplyThemeTokens({ force: true });
        useThemeRuntimeStore.getState().syncActiveTheme();
      }
      return true;
    },
    undoable: true,
  },
  alarms: {
    held: () => useAlarmConfigStore.getState().loaded,
    reload: () =>
      useAlarmConfigStore
        .getState()
        .load()
        .then(() => true),
  },
  recipes: {
    held: () => useRecipeConfigStore.getState().loaded,
    reload: () =>
      useRecipeConfigStore
        .getState()
        .load()
        .then(() => true),
  },
  historian: {
    held: () => useHistorianConfigStore.getState().config !== null,
    reload: () =>
      useHistorianConfigStore
        .getState()
        .load()
        .then(() => true),
  },
  users: {
    held: () => useUsersDomainStore.getState().data !== null,
    reload: () =>
      useUsersDomainStore
        .getState()
        .load()
        .then(() => true),
  },
  datasource: {
    held: () => useVariablesDomainStore.getState().listLoaded,
    reload: () =>
      useVariablesDomainStore
        .getState()
        .refreshSelected()
        .then(() => true),
  },
  variables: {
    held: () => useVariablesDomainStore.getState().listLoaded,
    reload: () =>
      useVariablesDomainStore
        .getState()
        .refreshSelected()
        .then(() => true),
  },
  http_origins: {
    held: () => useAdminViewStore.getState().httpOriginsLoaded,
    reload: () =>
      useAdminViewStore
        .getState()
        .loadHttpOrigins()
        .then(() => true),
  },
};

/** The domain an event changes, when this editor holds it; null otherwise. */
export function heldDomain(type: ArtifactType): Domain | null {
  const domain = DOMAINS[type];
  return domain?.held() ? domain : null;
}

const running = new Map<ArtifactType, Promise<boolean>>();
const again = new Set<ArtifactType>();

/**
 * Re-fetch what changed into the editor's stores, in place, and clear the undo
 * history after each pass that changed what undo covers, so undo cannot step
 * back over the other writer's change. Resolves false when an edit landed
 * meanwhile, so the change was not (all) applied.
 *
 * A save arrives as a burst (the index, then each page it wrote), so an event
 * landing while its kind is still reloading folds into one more run after that
 * one: the last fetch always starts after the last write, and an older
 * response can never land after a newer one.
 */
export function reloadEditor(type: ArtifactType, domain: Domain): Promise<boolean> {
  const inFlight = running.get(type);
  if (inFlight) {
    again.add(type);
    return inFlight;
  }
  const run = (async () => {
    let applied = true;
    do {
      again.delete(type);
      // A later pass would start from the author's new edit and overwrite it.
      if (editorHasUnsavedChanges()) {
        applied = false;
        break;
      }
      try {
        const passApplied = await domain.reload();
        // Right after the pass, while nothing is unsaved: a later pass skipped
        // for an edit must not leave snapshots that undo this change.
        if (passApplied && domain.undoable && !editorHasUnsavedChanges()) projectClearHistory();
        applied = passApplied && applied;
      } catch (err) {
        console.error(`[editorLiveSync] reloading ${type} failed:`, err);
      }
    } while (again.has(type));
    return applied && !editorHasUnsavedChanges();
  })().finally(() => running.delete(type));
  running.set(type, run);
  return run;
}
