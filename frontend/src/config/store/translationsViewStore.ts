import { create } from 'zustand';

type ConfirmActionType = 'delete-dictionary' | 'delete-key' | 'remove-language';

interface ConfirmState {
  message: string;
  action: ConfirmActionType;
  value: string;
}

interface TranslationsViewStore {
  filter: string;
  newRow: Record<string, string>;
  addError: string | null;
  showModal: boolean;
  confirm: ConfirmState | null;

  setFilter(filter: string): void;
  setNewRowValue(langCode: string, value: string): void;
  clearNewRow(): void;
  setAddError(error: string | null): void;
  setShowModal(v: boolean): void;
  askConfirm(message: string, action: ConfirmActionType, value: string): void;
  clearConfirm(): void;
}

export const useTranslationsViewStore = create<TranslationsViewStore>((set) => ({
  filter: '',
  newRow: {},
  addError: null,
  showModal: false,
  confirm: null,

  setFilter: (filter) => set({ filter }),

  setNewRowValue: (langCode, value) =>
    set((state) => ({
      addError: null,
      newRow: { ...state.newRow, [langCode]: value },
    })),

  clearNewRow: () => set({ newRow: {} }),

  setAddError: (error) => set({ addError: error }),

  setShowModal: (v) => set({ showModal: v }),

  askConfirm: (message, action, value) => set({ confirm: { message, action, value } }),

  clearConfirm: () => set({ confirm: null }),
}));
