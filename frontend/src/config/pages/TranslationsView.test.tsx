import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TranslationsView from './TranslationsView';
import { useTranslationStore } from '@shared/store/translationStore';
import { useTranslationsViewStore } from '../store/translationsViewStore';

const TRANSLATION_INITIAL = useTranslationStore.getState();

function stubStore(overrides: Partial<ReturnType<typeof useTranslationStore.getState>> = {}) {
  useTranslationStore.setState({
    languages: [{ code: 'en-EN' }, { code: 'nl-NL' }],
    translations: { Start: { 'en-EN': 'Start', 'nl-NL': 'Starten' } },
    dictionaries: ['Default', 'Motor'],
    activeDictionary: 'Default',
    error: null,
    loadDictionaries: vi.fn().mockResolvedValue(undefined),
    loadTranslations: vi.fn().mockResolvedValue(undefined),
    addTranslation: vi.fn().mockResolvedValue(undefined),
    updateCell: vi.fn(),
    deleteTranslation: vi.fn().mockResolvedValue(undefined),
    removeLanguage: vi.fn().mockResolvedValue(undefined),
    addDictionary: vi.fn().mockResolvedValue(undefined),
    deleteDictionary: vi.fn().mockResolvedValue(undefined),
    setActiveDictionary: vi.fn(),
    ...overrides,
  });
}

/** The open modal — ModalShell renders no ARIA role, so address it by class. */
function modal(): HTMLElement | null {
  return document.querySelector('.cfg-modal');
}

beforeEach(() => {
  useTranslationsViewStore.setState({
    filter: '',
    newRow: {},
    addError: null,
    showModal: false,
    confirm: null,
  });
  stubStore();
});

afterEach(() => {
  vi.restoreAllMocks();
  useTranslationStore.setState(TRANSLATION_INITIAL);
});

describe('TranslationsView', () => {
  it('loads dictionaries and translations on mount', () => {
    const loadDictionaries = vi.fn().mockResolvedValue(undefined);
    const loadTranslations = vi.fn().mockResolvedValue(undefined);
    stubStore({ loadDictionaries, loadTranslations });

    render(<TranslationsView />);

    expect(loadDictionaries).toHaveBeenCalledTimes(1);
    expect(loadTranslations).toHaveBeenCalledTimes(1);
  });

  it('renders a language column per language and the keys alphabetically', () => {
    stubStore({
      translations: { Zebra: { 'en-EN': 'Zebra' }, Apple: { 'en-EN': 'Apple' } },
    });
    render(<TranslationsView />);

    expect(screen.getByText('en-EN')).toBeInTheDocument();
    expect(screen.getByText('nl-NL')).toBeInTheDocument();
    const keys = screen.getAllByTitle('Immutable translation key').map((n) => n.textContent);
    expect(keys).toEqual(['Apple', 'Zebra']);
  });

  it('filters rows on key and on translated text', async () => {
    stubStore({
      translations: {
        Start: { 'en-EN': 'Start', 'nl-NL': 'Starten' },
        Stop: { 'en-EN': 'Stop', 'nl-NL': 'Stoppen' },
      },
    });
    render(<TranslationsView />);

    await userEvent.type(screen.getByLabelText('Search translations'), 'Stoppen');

    await waitFor(() => expect(screen.getAllByTitle('Immutable translation key')).toHaveLength(1));
    expect(screen.getByLabelText('Translation key: Stop')).toBeInTheDocument();
  });

  it('says nothing matched rather than showing an empty table', async () => {
    render(<TranslationsView />);

    await userEvent.type(screen.getByLabelText('Search translations'), 'zzz');

    expect(await screen.findByText('No translations match the search.')).toBeInTheDocument();
  });

  it('surfaces a backend translation error above the table', () => {
    stubStore({ error: 'Dictionary "Motor" is locked' });
    render(<TranslationsView />);

    expect(screen.getByText('Dictionary "Motor" is locked')).toBeInTheDocument();
  });

  it('creates a key through the backend and applies the other language cells', async () => {
    const addTranslation = vi.fn().mockImplementation(async (key: string) => {
      useTranslationStore.setState((s) => ({
        translations: { ...s.translations, [key]: { 'en-EN': key } },
      }));
    });
    const updateCell = vi.fn();
    stubStore({ addTranslation, updateCell });
    render(<TranslationsView />);

    const [primary, secondary] = screen.getAllByRole('textbox').slice(0, 2);
    await userEvent.type(primary, 'Reset');
    await userEvent.type(secondary, 'Resetten');
    await userEvent.type(secondary, '{Enter}');

    await waitFor(() => expect(addTranslation).toHaveBeenCalledWith('Reset'));
    expect(updateCell).toHaveBeenCalledWith('Reset', 'nl-NL', 'Resetten');
    expect(useTranslationsViewStore.getState().newRow).toEqual({});
  });

  it('rejects a key that already exists without calling the backend', async () => {
    const addTranslation = vi.fn().mockResolvedValue(undefined);
    stubStore({ addTranslation });
    render(<TranslationsView />);

    await userEvent.type(screen.getAllByRole('textbox')[0], 'Start{Enter}');

    expect(await screen.findByText('Translation "Start" already exists.')).toBeInTheDocument();
    expect(addTranslation).not.toHaveBeenCalled();
  });

  it('reports a backend add that silently failed to create the key', async () => {
    const addTranslation = vi.fn().mockResolvedValue(undefined);
    stubStore({ addTranslation });
    render(<TranslationsView />);

    await userEvent.type(screen.getAllByRole('textbox')[0], 'Reset{Enter}');

    expect(
      await screen.findByText('Could not add translation. Check backend/API and try again.'),
    ).toBeInTheDocument();
  });

  it('ignores an empty add row', async () => {
    const addTranslation = vi.fn().mockResolvedValue(undefined);
    stubStore({ addTranslation });
    render(<TranslationsView />);

    await userEvent.type(screen.getAllByRole('textbox')[0], '{Enter}');

    expect(addTranslation).not.toHaveBeenCalled();
    expect(useTranslationsViewStore.getState().addError).toBeNull();
  });

  it('refuses to add when the dictionary has no language column at all', async () => {
    const addTranslation = vi.fn().mockResolvedValue(undefined);
    stubStore({ languages: [], translations: {}, addTranslation });
    render(<TranslationsView />);

    useTranslationsViewStore.getState().setNewRowValue('en-EN', 'Reset');
    await userEvent.hover(screen.getByText(/No translations yet/));

    expect(addTranslation).not.toHaveBeenCalled();
  });

  it('confirms before deleting a translation key', async () => {
    const deleteTranslation = vi.fn().mockResolvedValue(undefined);
    stubStore({ deleteTranslation });
    render(<TranslationsView />);

    await userEvent.click(screen.getByTitle('Delete translation'));
    expect(await screen.findByText('Delete translation "Start"?')).toBeInTheDocument();
    expect(deleteTranslation).not.toHaveBeenCalled();

    await userEvent.click(within(modal() as HTMLElement).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteTranslation).toHaveBeenCalledWith('Start'));
    await waitFor(() => expect(modal()).toBeNull());
  });

  it('cancelling the delete confirmation leaves the key alone', async () => {
    const deleteTranslation = vi.fn().mockResolvedValue(undefined);
    stubStore({ deleteTranslation });
    render(<TranslationsView />);

    await userEvent.click(screen.getByTitle('Delete translation'));
    await userEvent.click(within(modal() as HTMLElement).getByRole('button', { name: 'Cancel' }));

    expect(deleteTranslation).not.toHaveBeenCalled();
    expect(modal()).toBeNull();
  });

  it('warns that removing a language column loses its translations', async () => {
    const removeLanguage = vi.fn().mockResolvedValue(undefined);
    stubStore({ removeLanguage });
    render(<TranslationsView />);

    await userEvent.click(screen.getByTitle('Remove nl-NL'));
    expect(
      await screen.findByText(/Remove language "nl-NL"\? All translations for this language/),
    ).toBeInTheDocument();

    await userEvent.click(within(modal() as HTMLElement).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(removeLanguage).toHaveBeenCalledWith('nl-NL'));
  });

  it('never offers to remove the primary language column', () => {
    render(<TranslationsView />);

    expect(screen.queryByTitle('Remove en-EN')).toBeNull();
  });

  it('lists dictionaries and switches the active one', async () => {
    const setActiveDictionary = vi.fn();
    stubStore({ setActiveDictionary });
    render(<TranslationsView />);

    expect(screen.getByText('Dictionaries')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Motor'));

    expect(setActiveDictionary).toHaveBeenCalledWith('Motor');
  });

  it('creates a dictionary from the tree action', async () => {
    const addDictionary = vi.fn().mockResolvedValue(undefined);
    stubStore({ addDictionary });
    render(<TranslationsView />);

    await userEvent.click(screen.getByTitle('New dictionary'));
    const dialog = modal() as HTMLElement;
    await userEvent.type(within(dialog).getByRole('textbox'), 'Pump');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(addDictionary).toHaveBeenCalledWith('Pump'));
    expect(modal()).toBeNull();
  });

  it('confirms before deleting a dictionary and its translations', async () => {
    const deleteDictionary = vi.fn().mockResolvedValue(undefined);
    stubStore({ deleteDictionary });
    render(<TranslationsView />);

    await userEvent.pointer({ keys: '[MouseRight]', target: screen.getByText('Motor') });
    await userEvent.click(await screen.findByText('Delete "Motor"…'));

    const dialog = modal() as HTMLElement;
    expect(
      within(dialog).getByText('Delete dictionary "Motor" and all its translations?'),
    ).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteDictionary).toHaveBeenCalledWith('Motor'));
  });

  it('offers no destructive action on the Default dictionary', async () => {
    render(<TranslationsView />);

    await userEvent.pointer({ keys: '[MouseRight]', target: screen.getByText('Default') });

    expect(await screen.findByText('No actions available')).toBeInTheDocument();
    expect(screen.queryByText('Delete "Default"…')).toBeNull();
  });
});
