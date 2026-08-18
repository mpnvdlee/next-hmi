import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTranslationStore } from '@shared/store/translationStore';
import TranslationInput from './index';

describe('TranslationInput search', () => {
  beforeEach(() => {
    useTranslationStore.setState({
      languages: [{ code: 'en' }, { code: 'nl' }],
      translations: {
        motor_on: { en: 'motor_on', nl: 'Motor aan' },
        pump_off: { en: 'pump_off', nl: 'Pomp uit' },
      },
    });
  });

  it('searches translated values and highlights the matching text', () => {
    const onChange = vi.fn();
    render(<TranslationInput value={null} onChange={onChange} translationOnly />);

    fireEvent.change(screen.getByPlaceholderText('Search translations…'), {
      target: { value: 'aan' },
    });

    const option = screen.getByRole('option', { name: /motor_on/i });
    expect(option).toHaveTextContent('Motor aan');
    expect(within(option).getByText('aan')).toHaveClass('cfg-search-match');
    expect(screen.queryByRole('option', { name: /pump_off/i })).not.toBeInTheDocument();

    fireEvent.mouseDown(option);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith({ $loc: 'motor_on' });
  });

  it('matches words across the key and its translated values', () => {
    render(<TranslationInput value={null} onChange={vi.fn()} translationOnly />);

    fireEvent.change(screen.getByPlaceholderText('Search translations…'), {
      target: { value: 'motor aan' },
    });

    const option = screen.getByRole('option', { name: /motor_on/i });
    expect(within(option).getByText('motor')).toHaveClass('cfg-search-match');
    expect(within(option).getByText('aan')).toHaveClass('cfg-search-match');
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('edits the translated values of the selected key from a popover', () => {
    render(<TranslationInput value={{ $loc: 'motor_on' }} onChange={vi.fn()} translationOnly />);

    fireEvent.click(screen.getByTitle('Edit translations'));

    const input = screen.getByDisplayValue('Motor aan');
    fireEvent.change(input, { target: { value: 'Motor draait' } });
    // Uncommitted until confirmed.
    expect(useTranslationStore.getState().translations.motor_on.nl).toBe('Motor aan');

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(useTranslationStore.getState().translations.motor_on.nl).toBe('Motor draait');
  });

  it('discards popover edits on cancel and commits them on Enter', () => {
    render(<TranslationInput value={{ $loc: 'motor_on' }} onChange={vi.fn()} translationOnly />);

    fireEvent.click(screen.getByTitle('Edit translations'));
    fireEvent.change(screen.getByDisplayValue('Motor aan'), { target: { value: 'Weg' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useTranslationStore.getState().translations.motor_on.nl).toBe('Motor aan');

    fireEvent.click(screen.getByTitle('Edit translations'));
    // The key column stays immutable.
    expect(screen.getByText('motor_on')).toHaveClass('editor-prop-translation__values-key');
    fireEvent.change(screen.getByDisplayValue('Motor aan'), { target: { value: 'Motor draait' } });
    fireEvent.keyDown(screen.getByDisplayValue('Motor draait'), { key: 'Enter' });

    expect(useTranslationStore.getState().translations.motor_on.nl).toBe('Motor draait');
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
  });

  it('portals the full-width dropdown outside the clipping properties panel', () => {
    render(<TranslationInput value={null} onChange={vi.fn()} translationOnly />);

    fireEvent.focus(screen.getByPlaceholderText('Search translations…'));

    const listbox = screen.getByRole('listbox');
    expect(listbox.parentElement).toBe(document.body);
    expect(listbox).toHaveStyle({ position: 'fixed', width: '400px' });
  });
});
