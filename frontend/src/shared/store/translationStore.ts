import { create } from 'zustand';
import { apiJson, isApiError } from '@shared/utils/api';
import { makeAbortableLoader } from '@shared/utils/abortableLoader';
import {
  projectClearHistory,
  projectIsDirty,
  projectMarkDirty,
  projectSnapshotAndDirty,
} from './projectActions';

export interface Language {
  code: string;
}

type TranslationRows = Record<string, Record<string, string>>;

interface TranslationData {
  languages: Language[];
  translations: TranslationRows;
}

interface DictionaryDraft extends TranslationData {
  revision: string;
}

export function normalizeTranslationData(
  languages: Language[],
  translations: TranslationRows,
): TranslationData {
  const seenCodes = new Set<string>();
  const normalizedLanguages = languages.map((language, index) => {
    if (!language || typeof language.code !== 'string' || !language.code.trim()) {
      throw new Error(`languages[${index}].code must be a non-empty string`);
    }
    if (seenCodes.has(language.code)) {
      throw new Error(`duplicate language code "${language.code}"`);
    }
    seenCodes.add(language.code);
    return { code: language.code };
  });
  if (normalizedLanguages.length === 0 && Object.keys(translations).length > 0) {
    throw new Error('translations require at least one language');
  }

  const primaryCode = normalizedLanguages[0]?.code;
  const normalizedRows: TranslationRows = {};
  for (const [key, values] of Object.entries(translations)) {
    if (!key.trim()) throw new Error('translation keys must be non-empty strings');
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new Error(`translation "${key}" must be an object`);
    }
    const normalizedValues: Record<string, string> = {};
    for (const [code, value] of Object.entries(values)) {
      if (!seenCodes.has(code)) {
        throw new Error(`translation "${key}" contains unknown language "${code}"`);
      }
      if (typeof value !== 'string') {
        throw new Error(`translation "${key}" values must be strings`);
      }
      if (code === primaryCode) continue;
      normalizedValues[code] = value;
    }
    normalizedRows[key] = normalizedValues;
  }

  return { languages: normalizedLanguages, translations: normalizedRows };
}

interface TranslationStore {
  languages: Language[];
  /** Translation key (en-EN value) → { langCode: translated text } */
  translations: TranslationRows;
  /** Revision of the loaded dictionary used for optimistic full-save concurrency. */
  revision: string;
  /** True once translations have been successfully fetched from the backend at least once. */
  loaded: boolean;
  /** Active language code, persisted to localStorage */
  activeLanguage: string;
  setActiveLanguage(code: string): void;
  /** Resolve a translation key to the active language text. Falls back to key itself. */
  resolve(key: string): string;

  /** Available dictionary names (e.g. ["Default", "Motor"]) */
  dictionaries: string[];
  /** Currently selected dictionary */
  activeDictionary: string;
  /** Load the list of dictionaries from the backend */
  loadDictionaries(): Promise<void>;
  /** Create a new dictionary on the backend and switch to it */
  addDictionary(name: string): Promise<void>;
  /** Delete a dictionary by name (Default cannot be deleted) */
  deleteDictionary(name: string): Promise<void>;
  /** Switch the active dictionary and reload translations */
  setActiveDictionary(name: string): void;

  /** Fetch translations from the backend (for the active dictionary) */
  loadTranslations(options?: { force?: boolean }): Promise<void>;
  /** Add a new translation key (en-EN only, other columns empty) */
  addTranslation(enKey: string): Promise<void>;
  /** Update a non-primary cell: translations[key][langCode] = value */
  updateCell(key: string, langCode: string, value: string): void;
  /** Full save to backend */
  saveTranslations(): Promise<boolean>;
  /** Delete a translation row by key */
  deleteTranslation(key: string): Promise<void>;
  /** Add a new language column */
  addLanguage(code: string): Promise<void>;
  /** Remove a language column */
  removeLanguage(code: string): Promise<void>;

  /** In-memory unsaved state per dictionary (not persisted across full refresh). */
  _draftsByDictionary: Record<string, DictionaryDraft>;
  /** Last backend error for translation operations. */
  error: string | null;
  /** Apply a translations snapshot received from a parent frame (editor → preview bridge). */
  applyTranslationsUpdate(data: { languages: Language[]; translations: TranslationRows }): void;
}

const STORAGE_KEY = 'nexthmi-language';

function applyData(data: {
  languages?: Language[];
  rows?: TranslationRows;
  revision?: string;
}): DictionaryDraft {
  if (typeof data.revision !== 'string') throw new Error('translation revision is missing');
  return {
    ...normalizeTranslationData(data.languages ?? [], data.rows ?? {}),
    revision: data.revision,
  };
}

function createDraft(
  languages: Language[],
  translations: TranslationRows,
  revision: string,
): DictionaryDraft {
  const normalized = normalizeTranslationData(languages, translations);
  return {
    languages: structuredClone(normalized.languages),
    translations: structuredClone(normalized.translations),
    revision,
  };
}

function latestDictionaryDraft(
  state: Pick<
    TranslationStore,
    '_draftsByDictionary' | 'activeDictionary' | 'languages' | 'translations' | 'revision'
  >,
  dictionary: string,
  fallback: DictionaryDraft,
): DictionaryDraft {
  if (state.activeDictionary === dictionary) {
    return createDraft(state.languages, state.translations, state.revision);
  }
  return state._draftsByDictionary[dictionary] ?? fallback;
}

type MutationEffect =
  | { kind: 'add-row'; key: string }
  | { kind: 'delete-row'; key: string }
  | { kind: 'add-language'; code: string }
  | { kind: 'remove-language'; code: string }
  | { kind: 'save' };

function applyStructuralEffect(
  server: DictionaryDraft,
  local: DictionaryDraft,
  effect: MutationEffect,
): DictionaryDraft {
  let languages = structuredClone(local.languages);
  const translations = structuredClone(local.translations);

  switch (effect.kind) {
    case 'add-row':
      if (!Object.prototype.hasOwnProperty.call(translations, effect.key)) {
        translations[effect.key] = structuredClone(server.translations[effect.key] ?? {});
      }
      break;
    case 'delete-row':
      delete translations[effect.key];
      break;
    case 'add-language':
      if (!languages.some(({ code }) => code === effect.code)) {
        languages = [...languages, { code: effect.code }];
      }
      for (const [key, values] of Object.entries(translations)) {
        if (!Object.prototype.hasOwnProperty.call(values, effect.code)) {
          values[effect.code] = server.translations[key]?.[effect.code] ?? '';
        }
      }
      break;
    case 'remove-language':
      languages = languages.filter(({ code }) => code !== effect.code);
      for (const values of Object.values(translations)) delete values[effect.code];
      break;
    case 'save':
      break;
  }

  return createDraft(languages, translations, server.revision);
}

function reconcileMutationResult(
  state: Pick<
    TranslationStore,
    '_draftsByDictionary' | 'activeDictionary' | 'languages' | 'translations' | 'revision'
  >,
  dictionary: string,
  data: { languages?: Language[]; rows?: TranslationRows; revision?: string },
  fallback: DictionaryDraft,
  effect: MutationEffect,
) {
  const server = applyData(data);
  const local = latestDictionaryDraft(state, dictionary, fallback);
  const applied = applyStructuralEffect(server, local, effect);
  const draftState = {
    _draftsByDictionary: {
      ...state._draftsByDictionary,
      [dictionary]: createDraft(applied.languages, applied.translations, applied.revision),
    },
  };
  if (state.activeDictionary !== dictionary) return draftState;
  return { ...applied, loaded: true, ...draftState };
}

export const useTranslationStore = create<TranslationStore>((set, get) => {
  const dictionariesLoader = makeAbortableLoader();
  const translationsLoader = makeAbortableLoader();

  return {
    languages: [],
    translations: {},
    revision: 'missing',
    loaded: false,
    activeLanguage: localStorage.getItem(STORAGE_KEY) ?? '',
    error: null,

    dictionaries: ['Default'],
    activeDictionary: 'Default',
    _draftsByDictionary: {},

    setActiveLanguage: (code) => {
      localStorage.setItem(STORAGE_KEY, code);
      set({ activeLanguage: code });
    },

    resolve: (key) => {
      const { translations, activeLanguage, languages } = get();
      const entry = translations[key];
      if (!entry) return key;
      if (activeLanguage === languages[0]?.code) return key;
      const text = entry[activeLanguage];
      if (text) return text;
      return key;
    },

    loadDictionaries: async () => {
      const controller = dictionariesLoader.begin();
      try {
        const data = await apiJson<Array<{ name: string }>>('/api/config/dictionaries', {
          signal: controller.signal,
        });
        if (!dictionariesLoader.isCurrent(controller)) return;
        const dictionaries = data.map((d) => d.name);
        set((state) => {
          const nextDrafts = Object.fromEntries(
            Object.entries(state._draftsByDictionary).filter(([name]) =>
              dictionaries.includes(name),
            ),
          );
          return { dictionaries, _draftsByDictionary: nextDrafts, error: null };
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error('[translationStore] Failed to load dictionaries:', err);
        set({ error: 'Could not load dictionaries.' });
      } finally {
        dictionariesLoader.finalize(controller);
      }
    },

    addDictionary: async (name) => {
      try {
        const data = await apiJson<Array<{ name: string }>>('/api/config/dictionaries', {
          method: 'POST',
          body: { name },
        });
        const dictionaries = data.map((d) => d.name);
        set({ dictionaries, activeDictionary: name, loaded: false, error: null });
        await get().loadTranslations({ force: true });
      } catch (err) {
        console.error('[translationStore] Failed to add dictionary:', err);
        set({ error: `Could not add dictionary "${name}".` });
      }
    },

    deleteDictionary: async (name) => {
      try {
        const data = await apiJson<Array<{ name: string }>>(
          `/api/config/dictionaries/${encodeURIComponent(name)}`,
          { method: 'DELETE' },
        );
        const dictionaries = data.map((d) => d.name);
        // If the deleted dict was active, fall back to Default
        const { activeDictionary } = get();
        const nextActive = activeDictionary === name ? 'Default' : activeDictionary;
        set({ dictionaries, activeDictionary: nextActive, loaded: false, error: null });
        await get().loadTranslations({ force: true });
      } catch (err) {
        console.error('[translationStore] Failed to delete dictionary:', err);
        set({ error: `Could not delete dictionary "${name}".` });
      }
    },

    setActiveDictionary: (name) => {
      const { activeDictionary, languages, translations, revision, _draftsByDictionary } = get();
      const nextDrafts = {
        ..._draftsByDictionary,
        [activeDictionary]: createDraft(languages, translations, revision),
      };

      const existingTargetDraft = nextDrafts[name];
      if (existingTargetDraft) {
        set({
          activeDictionary: name,
          loaded: true,
          languages: structuredClone(existingTargetDraft.languages),
          translations: structuredClone(existingTargetDraft.translations),
          revision: existingTargetDraft.revision,
          _draftsByDictionary: nextDrafts,
        });
        return;
      }

      set({ activeDictionary: name, loaded: false, _draftsByDictionary: nextDrafts, error: null });
      void get().loadTranslations({ force: true });
    },

    loadTranslations: async (options) => {
      const force = options?.force === true;
      const { activeDictionary, loaded } = get();
      if (!force && loaded && projectIsDirty()) return;

      const controller = translationsLoader.begin();

      const requestDictionary = activeDictionary;
      try {
        const data = await apiJson<{
          languages?: Language[];
          rows?: TranslationRows;
          revision?: string;
        }>(`/api/config/translations?dict=${encodeURIComponent(requestDictionary)}`, {
          signal: controller.signal,
        });
        const normalized = applyData(data);
        const { languages, translations, revision } = normalized;

        // Do not overwrite local unsaved edits when this was a normal reload path.
        const stateNow = get();
        if (!force && stateNow.loaded && projectIsDirty()) return;
        if (stateNow.activeDictionary !== requestDictionary) return;

        const current = stateNow.activeLanguage;
        const activeLanguage =
          current && languages.some((l) => l.code === current)
            ? current
            : (languages[0]?.code ?? '');
        set((state) => ({
          languages,
          translations,
          revision,
          activeLanguage,
          loaded: true,
          error: null,
          _draftsByDictionary: {
            ...state._draftsByDictionary,
            [requestDictionary]: createDraft(languages, translations, revision),
          },
        }));
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error('[translationStore] Failed to load translations:', err);
        set({ error: 'Could not load translations.' });
      } finally {
        translationsLoader.finalize(controller);
      }
    },

    addTranslation: async (enKey) => {
      const { activeDictionary, languages, translations, revision } = get();
      const invocationDraft = createDraft(languages, translations, revision);
      projectMarkDirty();
      try {
        const data = await apiJson<{
          languages?: Language[];
          rows?: TranslationRows;
          revision?: string;
        }>(`/api/config/translations?dict=${encodeURIComponent(activeDictionary)}`, {
          method: 'POST',
          body: { key: enKey },
        });
        set((state) => ({
          ...reconcileMutationResult(state, activeDictionary, data, invocationDraft, {
            kind: 'add-row',
            key: enKey,
          }),
          error: null,
        }));
        projectClearHistory();
      } catch (err) {
        console.error('[translationStore] Failed to add translation:', err);
        set({ error: `Could not add translation "${enKey}".` });
      }
    },

    updateCell: (key, langCode, value) => {
      const { languages, translations: currentTranslations } = get();
      if (langCode === languages[0]?.code) {
        set({ error: 'The primary translation value is an immutable lookup key.' });
        return;
      }
      if (!languages.some((language) => language.code === langCode)) {
        set({ error: `Language "${langCode}" does not exist.` });
        return;
      }
      if (!(key in currentTranslations)) {
        set({ error: `Translation "${key}" does not exist.` });
        return;
      }
      projectMarkDirty();
      set((state) => {
        const entry = state.translations[key] ?? {};
        const translations = {
          ...state.translations,
          [key]: { ...entry, [langCode]: value },
        };
        return {
          translations,
          _draftsByDictionary: {
            ...state._draftsByDictionary,
            [state.activeDictionary]: createDraft(state.languages, translations, state.revision),
          },
          error: null,
        };
      });
    },

    saveTranslations: async () => {
      const { languages, translations, revision, activeDictionary } = get();
      const invocationDraft = createDraft(languages, translations, revision);
      if (!get().loaded && languages.length === 0 && Object.keys(translations).length === 0) {
        console.warn(
          '[translationStore] Skipping save: translations were never loaded from backend',
        );
        return true;
      }
      try {
        const normalized = normalizeTranslationData(languages, translations);
        const data = await apiJson<{
          languages?: Language[];
          rows?: TranslationRows;
          revision?: string;
        }>(`/api/config/translations?dict=${encodeURIComponent(activeDictionary)}`, {
          method: 'PUT',
          body: {
            languages: normalized.languages,
            rows: normalized.translations,
            revision,
          },
        });
        set((state) => ({
          ...reconcileMutationResult(state, activeDictionary, data, invocationDraft, {
            kind: 'save',
          }),
          error: null,
        }));
        return true;
      } catch (err) {
        console.error('[translationStore] Failed to save translations:', err);
        set({
          error:
            isApiError(err) && err.status === 409
              ? 'Translations changed on the server. Your draft was kept; reload before saving.'
              : 'Could not save translations.',
        });
        return false;
      }
    },

    deleteTranslation: async (key) => {
      const { activeDictionary, languages, translations, revision } = get();
      const invocationDraft = createDraft(languages, translations, revision);
      projectMarkDirty();
      try {
        const data = await apiJson<{
          languages?: Language[];
          rows?: TranslationRows;
          revision?: string;
        }>(
          `/api/config/translations/${encodeURIComponent(key)}?dict=${encodeURIComponent(activeDictionary)}`,
          { method: 'DELETE' },
        );
        set((state) => ({
          ...reconcileMutationResult(state, activeDictionary, data, invocationDraft, {
            kind: 'delete-row',
            key,
          }),
          error: null,
        }));
        projectClearHistory();
      } catch (err) {
        console.error('[translationStore] Failed to delete translation:', err);
        set({ error: `Could not delete translation "${key}".` });
      }
    },

    addLanguage: async (code) => {
      const { activeDictionary, languages, translations, revision } = get();
      const invocationDraft = createDraft(languages, translations, revision);
      projectSnapshotAndDirty();
      try {
        const data = await apiJson<{
          languages?: Language[];
          rows?: TranslationRows;
          revision?: string;
        }>(`/api/config/translations/language?dict=${encodeURIComponent(activeDictionary)}`, {
          method: 'POST',
          body: { code },
        });
        set((state) => ({
          ...reconcileMutationResult(state, activeDictionary, data, invocationDraft, {
            kind: 'add-language',
            code,
          }),
          error: null,
        }));
      } catch (err) {
        console.error('[translationStore] Failed to add language:', err);
        set({ error: `Could not add language "${code}".` });
      }
    },

    removeLanguage: async (code) => {
      const { activeDictionary, languages, translations, revision } = get();
      const invocationDraft = createDraft(languages, translations, revision);
      projectSnapshotAndDirty();
      try {
        const data = await apiJson<{
          languages?: Language[];
          rows?: TranslationRows;
          revision?: string;
        }>(
          `/api/config/translations/language/${encodeURIComponent(code)}?dict=${encodeURIComponent(activeDictionary)}`,
          { method: 'DELETE' },
        );
        set((state) => ({
          ...reconcileMutationResult(state, activeDictionary, data, invocationDraft, {
            kind: 'remove-language',
            code,
          }),
          error: null,
        }));
      } catch (err) {
        console.error('[translationStore] Failed to remove language:', err);
        set({ error: `Could not remove language "${code}".` });
      }
    },

    applyTranslationsUpdate: ({ languages, translations }) => {
      const normalized = normalizeTranslationData(languages, translations);
      set((state) => ({
        ...normalized,
        loaded: true,
        activeLanguage: normalized.languages.some((l) => l.code === state.activeLanguage)
          ? state.activeLanguage
          : (normalized.languages[0]?.code ?? state.activeLanguage),
      }));
    },
  };
});
