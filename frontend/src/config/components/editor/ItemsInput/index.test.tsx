import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTranslationStore } from '@shared/store/translationStore';
import ItemsInput from './index';

/** Opens the drawer on an option, as a click on its line in the panel does. */
const open = (idx = 0) => fireEvent.click(screen.getAllByTitle('Edit option')[idx]);

describe('ItemsInput — string values (the default)', () => {
  it('edits a value through the plain text cell', () => {
    const onChange = vi.fn();
    render(<ItemsInput value={[{ label: 'Auto', value: 'auto' }]} onChange={onChange} />);
    open();

    fireEvent.change(screen.getByDisplayValue('auto'), { target: { value: 'manual' } });

    expect(onChange).toHaveBeenCalledWith([{ label: 'Auto', value: 'manual' }]);
  });

  it('adds a row with an empty string value', () => {
    const onChange = vi.fn();
    render(<ItemsInput value={[]} onChange={onChange} />);

    fireEvent.click(screen.getByTitle('Add option'));

    expect(onChange).toHaveBeenCalledWith([{ label: '', value: '' }]);
  });
});

describe('ItemsInput — number values', () => {
  it('stores a real number for an integer list, not a numeric string', () => {
    const onChange = vi.fn();
    render(
      <ItemsInput valueType="integer" value={[{ label: 'Small', value: 0 }]} onChange={onChange} />,
    );
    open();

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '10' } });

    expect(onChange).toHaveBeenCalledWith([{ label: 'Small', value: 10 }]);
  });

  it('steps an integer cell by one and a float cell by any amount', () => {
    const { unmount } = render(
      <ItemsInput valueType="integer" value={[{ label: 'A', value: 1 }]} onChange={vi.fn()} />,
    );
    open();
    expect(screen.getByRole('spinbutton')).toHaveAttribute('step', '1');
    unmount();

    render(<ItemsInput valueType="float" value={[{ label: 'A', value: 1 }]} onChange={vi.fn()} />);
    open();
    expect(screen.getByRole('spinbutton')).toHaveAttribute('step', 'any');
  });

  it('keeps a fractional float value', () => {
    const onChange = vi.fn();
    render(
      <ItemsInput valueType="float" value={[{ label: 'Slow', value: 0 }]} onChange={onChange} />,
    );
    open();

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '0.25' } });

    expect(onChange).toHaveBeenCalledWith([{ label: 'Slow', value: 0.25 }]);
  });

  // NaN would be written straight into the component definition and read back
  // as `null`, silently turning a numbered option into a valueless one.
  it('stores nothing rather than NaN when a number cell is emptied', () => {
    const onChange = vi.fn();
    render(
      <ItemsInput
        valueType="integer"
        value={[{ label: 'Small', value: 10 }]}
        onChange={onChange}
      />,
    );
    open();

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '' } });

    expect(onChange).toHaveBeenCalledWith([{ label: 'Small', value: undefined }]);
  });

  it('adds a number row at zero rather than at an empty string', () => {
    const onChange = vi.fn();
    render(<ItemsInput valueType="integer" value={[]} onChange={onChange} />);

    fireEvent.click(screen.getByTitle('Add option'));

    expect(onChange).toHaveBeenCalledWith([{ label: '', value: 0 }]);
  });
});

describe('ItemsInput — boolean values', () => {
  it('stores a real boolean', () => {
    const onChange = vi.fn();
    render(
      <ItemsInput
        valueType="boolean"
        value={[{ label: 'Forward', value: false }]}
        onChange={onChange}
      />,
    );
    open();

    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));

    expect(onChange).toHaveBeenCalledWith([{ label: 'Forward', value: true }]);
  });

  it('adds a boolean row at false', () => {
    const onChange = vi.fn();
    render(<ItemsInput valueType="boolean" value={[]} onChange={onChange} />);

    fireEvent.click(screen.getByTitle('Add option'));

    expect(onChange).toHaveBeenCalledWith([{ label: '', value: false }]);
  });
});

describe('ItemsInput — localisable values', () => {
  beforeEach(() => {
    useTranslationStore.setState({
      languages: [{ code: 'en' }, { code: 'nl' }],
      translations: {
        motor_on: { en: 'motor_on', nl: 'Motor aan' },
        pump_off: { en: 'pump_off', nl: 'Pomp uit' },
      },
    });
  });

  it('stores the translation key as a $loc value', () => {
    const onChange = vi.fn();
    render(
      <ItemsInput
        valueType="loc"
        value={[{ label: 'Running', value: undefined }]}
        onChange={onChange}
      />,
    );
    open();

    fireEvent.change(screen.getByPlaceholderText('Search translations…'), {
      target: { value: 'motor' },
    });
    fireEvent.click(screen.getByRole('option', { name: /motor_on/i }));

    expect(onChange).toHaveBeenCalledWith([{ label: 'Running', value: { $loc: 'motor_on' } }]);
  });

  it('adds a localisable row with no key picked yet', () => {
    const onChange = vi.fn();
    render(<ItemsInput valueType="loc" value={[]} onChange={onChange} />);

    fireEvent.click(screen.getByTitle('Add option'));

    expect(onChange).toHaveBeenCalledWith([{ label: '', value: undefined }]);
  });

  it('offers no free-text value cell, so only a declared translation can be picked', () => {
    render(
      <ItemsInput
        valueType="loc"
        value={[{ label: 'Running', value: { $loc: 'motor_on' } }]}
        onChange={vi.fn()}
      />,
    );
    open();

    expect(screen.queryByPlaceholderText('Value')).not.toBeInTheDocument();
  });
});

describe('ItemsInput — a widget Options list', () => {
  beforeEach(() => {
    useTranslationStore.setState({
      languages: [{ code: 'en' }],
      translations: { 'pack.tray': { en: 'Tray' } },
    });
  });

  it('lists one line per option, value first, with no source mark on a translated label', () => {
    render(
      <ItemsInput
        value={[
          { label: { $loc: 'pack.tray' }, value: 'tray' },
          { label: 'Box', value: 'box' },
        ]}
        onChange={vi.fn()}
      />,
    );

    const rows = screen.getAllByTitle('Edit option');
    expect(rows.map((r) => r.textContent)).toEqual(['traypack.tray', 'boxBox']);
    expect(rows[0].querySelector('[title="Localizable Text"]')).toBeNull();
  });

  it('opens the drawer on the clicked option, its label a Static or Localizable Text field', () => {
    render(
      <ItemsInput
        value={[
          { label: 'Tray', value: 'tray' },
          { label: 'Box', value: 'box' },
        ]}
        onChange={vi.fn()}
      />,
    );
    open(1);

    const expanded = document.querySelectorAll(
      '.cfg-list-drawer .cfg-sortable-row__body > .cfg-field-group > .cfg-field-group__box > .cfg-field-group__nest',
    );
    expect(expanded).toHaveLength(1);
    expect(expanded[0].querySelector('input')).toHaveValue('box');
    expect(screen.queryByTitle('Plain text — click for Translation')).not.toBeInTheDocument();
    expect(screen.getAllByDisplayValue('Box')).toHaveLength(1);
  });

  it('opens every option expanded from the ⤢', () => {
    render(
      <ItemsInput
        value={[
          { label: 'Tray', value: 'tray' },
          { label: 'Box', value: 'box' },
        ]}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTitle('Expand in drawer'));
    expect(document.querySelectorAll('.cfg-list-drawer .cfg-field-group__nest')).toHaveLength(2);
  });

  it('gives every option a ⋮⋮ grip to reorder it by, which does not open the drawer', () => {
    render(
      <ItemsInput
        value={[
          { label: 'A', value: 'a' },
          { label: 'B', value: 'b' },
        ]}
        onChange={vi.fn()}
      />,
    );

    const grips = screen.getAllByTitle('Drag to reorder');
    expect(grips).toHaveLength(2);
    fireEvent.click(grips[1]);
    expect(document.querySelector('.cfg-list-drawer')).toBeNull();
  });

  it('shows and keeps numeric values when no value kind is declared', () => {
    const onChange = vi.fn();
    render(<ItemsInput value={[{ label: 'One', value: 1 }]} onChange={onChange} />);
    expect(screen.getByText('1')).toBeInTheDocument();
    open();

    expect(screen.getByRole('spinbutton')).toHaveValue(1);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2' } });

    expect(onChange).toHaveBeenCalledWith([{ label: 'One', value: 2 }]);
  });
});
