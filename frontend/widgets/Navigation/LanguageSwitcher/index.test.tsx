import '../../testSdk';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { useTranslationStore } from '@shared/store/translationStore';
import LanguageSwitcher from './index';

function setLanguages(codes: string[], activeLanguage = codes[0] ?? '') {
  useTranslationStore.setState({ languages: codes.map((code) => ({ code })), activeLanguage });
}

function renderSwitcher(properties: Record<string, unknown> = {}) {
  return render(
    <MemoryRouter>
      <LanguageSwitcher properties={properties} />
    </MemoryRouter>,
  );
}

const select = () => screen.getByRole('combobox') as HTMLSelectElement;
const optionTexts = () => screen.getAllByRole('option').map((o) => o.textContent);

describe('LanguageSwitcher', () => {
  beforeEach(() => {
    setLanguages(['en', 'de', 'fr']);
  });

  it('renders with no properties set', () => {
    const { container } = renderSwitcher({});
    expect(container.querySelector('.hmi-language-switcher')).not.toBeNull();
  });

  it('roots itself in a label carrying both the base and widget classes', () => {
    const { container } = renderSwitcher({});
    // `hmi-component` is the self-layout barrier: it is the only consumer of the
    // `--self-*` properties `selfLayoutStyle()` emits, so without it every
    // layout field the author sets in the editor is silently inert.
    const root = container.firstElementChild as HTMLElement;
    expect(root.tagName).toBe('LABEL');
    expect(root.className).toContain('hmi-component');
    expect(root.className).toContain('hmi-language-switcher');
  });

  it('labels the picker "Language" by default', () => {
    const { container } = renderSwitcher({});
    expect(container.querySelector('.hmi-language-switcher__label')?.textContent).toBe('Language');
  });

  it('uses the configured label', () => {
    const { container } = renderSwitcher({ label: 'Taal' });
    expect(container.querySelector('.hmi-language-switcher__label')?.textContent).toBe('Taal');
  });

  it('offers one option per configured language, in order', () => {
    renderSwitcher();
    expect(optionTexts()).toEqual(['en', 'de', 'fr']);
  });

  it('shows the active language as the selection', () => {
    setLanguages(['en', 'de', 'fr'], 'de');
    renderSwitcher();
    expect(select().value).toBe('de');
  });

  it('falls back to the first language when none is active yet', () => {
    setLanguages(['en', 'de', 'fr'], '');
    renderSwitcher();
    expect(select().value).toBe('en');
  });

  it('switches the interface language when one is chosen', async () => {
    const user = userEvent.setup();
    setLanguages(['en', 'de', 'fr'], 'en');
    renderSwitcher();
    await user.selectOptions(select(), 'fr');
    expect(useTranslationStore.getState().activeLanguage).toBe('fr');
    expect(select().value).toBe('fr');
  });

  it('offers a single "default" option when no languages are configured', () => {
    setLanguages([]);
    renderSwitcher();
    expect(optionTexts()).toEqual(['default']);
    expect(select().value).toBe('default');
  });

  it('still renders its label when no languages are configured', () => {
    setLanguages([]);
    const { container } = renderSwitcher({ label: 'Taal' });
    expect(container.querySelector('.hmi-language-switcher__label')?.textContent).toBe('Taal');
  });

  it('offers the one option, already selected, for a single-language project', () => {
    setLanguages(['en']);
    renderSwitcher();
    expect(optionTexts()).toEqual(['en']);
    expect(select().value).toBe('en');
  });

  it('drops back to the first option when the active language is no longer configured', () => {
    setLanguages(['en', 'de'], 'fr');
    renderSwitcher();
    expect(optionTexts()).toEqual(['en', 'de']);
    // No option matches 'fr', so the select shows its first one while the store
    // still holds 'fr' — the picker and the active language disagree.
    expect(select().value).toBe('en');
    expect(useTranslationStore.getState().activeLanguage).toBe('fr');
  });
});
