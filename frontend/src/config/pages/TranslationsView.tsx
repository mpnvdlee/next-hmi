/**
 * TranslationsView — /translations
 *
 * Management page for the translations CSV.  Follows the same layout pattern
 * as VariablesView: full-height config layout with a toolbar at the top and a
 * scrollable table below.
 *
 * Features:
 *   - Search bar filtering translation keys
 *   - Inline-editable cells per language column
 *   - Delete individual translation rows
 *   - Add / remove language columns
 *   - Dirty tracking with explicit global Save
 */

import { useMemo, useEffect } from 'react';
import ConfigLayout from '../components/ui/ConfigLayout';
import DictionaryTree from '../components/translations/DictionaryTree';
import NameInputModal from '../components/ui/NameInputModal';
import ConfirmModal from '../components/ui/ConfirmModal';
import TranslationsTable from '../components/translations/TranslationsTable';
import { useTranslationStore } from '@shared/store/translationStore';
import { useTranslationsViewStore } from '../store/translationsViewStore';
import type { Language } from '@shared/store/translationStore';
import { matchesSearchWords } from '@shared/utils/search';

export default function TranslationsView() {
  const languages = useTranslationStore((s) => s.languages);
  const translations = useTranslationStore((s) => s.translations);
  const loadTranslations = useTranslationStore((s) => s.loadTranslations);
  const addTranslation = useTranslationStore((s) => s.addTranslation);
  const updateCell = useTranslationStore((s) => s.updateCell);
  const deleteTranslation = useTranslationStore((s) => s.deleteTranslation);
  const removeLanguage = useTranslationStore((s) => s.removeLanguage);
  const dictionaries = useTranslationStore((s) => s.dictionaries);
  const activeDictionary = useTranslationStore((s) => s.activeDictionary);
  const loadDictionaries = useTranslationStore((s) => s.loadDictionaries);
  const addDictionary = useTranslationStore((s) => s.addDictionary);
  const deleteDictionary = useTranslationStore((s) => s.deleteDictionary);
  const setActiveDictionary = useTranslationStore((s) => s.setActiveDictionary);
  const translationError = useTranslationStore((s) => s.error);

  const filter = useTranslationsViewStore((s) => s.filter);
  const newRow = useTranslationsViewStore((s) => s.newRow);
  const addError = useTranslationsViewStore((s) => s.addError);
  const showModal = useTranslationsViewStore((s) => s.showModal);
  const confirm = useTranslationsViewStore((s) => s.confirm);
  const setFilter = useTranslationsViewStore((s) => s.setFilter);
  const setNewRowValue = useTranslationsViewStore((s) => s.setNewRowValue);
  const clearNewRow = useTranslationsViewStore((s) => s.clearNewRow);
  const setAddError = useTranslationsViewStore((s) => s.setAddError);
  const setShowModal = useTranslationsViewStore((s) => s.setShowModal);
  const askConfirm = useTranslationsViewStore((s) => s.askConfirm);
  const clearConfirm = useTranslationsViewStore((s) => s.clearConfirm);

  // Load dictionaries and translations on mount
  useEffect(() => {
    void loadDictionaries();
    void loadTranslations();
  }, [loadDictionaries, loadTranslations]);

  async function handleAddDictionary(name: string) {
    setShowModal(false);
    await addDictionary(name);
  }

  function handleDeleteDictionary(name: string) {
    askConfirm(`Delete dictionary "${name}" and all its translations?`, 'delete-dictionary', name);
  }

  const keys = useMemo(
    () => Object.keys(translations).sort((a, b) => a.localeCompare(b)),
    [translations],
  );

  const filtered = useMemo(() => {
    if (!filter.trim()) return keys;
    return keys.filter((key) =>
      matchesSearchWords(filter, [key, ...Object.values(translations[key])]),
    );
  }, [keys, filter, translations]);

  async function submitNewRow() {
    const firstLang = languages[0]?.code;
    if (!firstLang) {
      setAddError('No language column available.');
      return;
    }
    const key = (newRow[firstLang] ?? '').trim();
    if (!key) return;

    if (translations[key]) {
      setAddError(`Translation "${key}" already exists.`);
      return;
    }

    // Create the key via backend first so add-row behavior stays persisted and
    // duplicate handling remains consistent with the API.
    await addTranslation(key);

    const created = Boolean(useTranslationStore.getState().translations[key]);
    if (!created) {
      setAddError('Could not add translation. Check backend/API and try again.');
      return;
    }

    // Apply any non-primary language values entered in the add row.
    for (const lang of languages) {
      if (lang.code === firstLang) continue;
      const val = (newRow[lang.code] ?? '').trim();
      if (val) updateCell(key, lang.code, val);
    }

    clearNewRow();
    setAddError(null);
  }

  function handleDeleteKey(key: string) {
    askConfirm(`Delete translation "${key}"?`, 'delete-key', key);
  }

  function handleRemoveLanguage(lang: Language) {
    askConfirm(
      `Remove language "${lang.code}"? All translations for this language will be lost.`,
      'remove-language',
      lang.code,
    );
  }

  async function handleConfirmAction() {
    if (!confirm) return;
    if (confirm.action === 'delete-dictionary') {
      await deleteDictionary(confirm.value);
    } else if (confirm.action === 'delete-key') {
      await deleteTranslation(confirm.value);
    } else if (confirm.action === 'remove-language') {
      await removeLanguage(confirm.value);
    }
    clearConfirm();
  }

  const translationTable = (
    <>
      {translationError && <div className="cfg-error-banner">{translationError}</div>}
      <TranslationsTable
        languages={languages}
        filtered={filtered}
        translations={translations}
        newRow={newRow}
        addError={addError}
        filter={filter}
        onUpdateCell={updateCell}
        onDeleteKey={handleDeleteKey}
        onSetNewRowValue={setNewRowValue}
        onSubmitNewRow={() => {
          void submitNewRow();
        }}
        onRemoveLanguage={handleRemoveLanguage}
        onFilterChange={setFilter}
      />
    </>
  );

  return (
    <>
      {showModal && (
        <NameInputModal onConfirm={handleAddDictionary} onCancel={() => setShowModal(false)} />
      )}
      {confirm && (
        <ConfirmModal
          message={confirm.message}
          confirmLabel="Delete"
          danger
          onConfirm={() => {
            void handleConfirmAction();
          }}
          onCancel={() => clearConfirm()}
        />
      )}
      <ConfigLayout
        storageKey="translations"
        left={
          <DictionaryTree
            dictionaries={dictionaries}
            active={activeDictionary}
            onSelect={setActiveDictionary}
            onAdd={() => setShowModal(true)}
            onDelete={handleDeleteDictionary}
          />
        }
        center={translationTable}
      />
    </>
  );
}
