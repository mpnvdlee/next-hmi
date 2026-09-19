import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTranslationStore } from '@shared/store/translationStore';
import ItemsInput from './index';

describe('ItemsInput — string values (the default)', () => {
  it('edits a value through the plain text cell', () => {
    const onChange = vi.fn();
    render(<ItemsInput value={[{ label: 'Auto', value: 'auto' }]} onChange={onChange} />);

    fireEvent.change(screen.getByDisplayValue('auto'), { target: { value: 'manual' } });

    expect(onChange).toHaveBeenCalledWith([{ label: 'Auto', value: 'manual' }]);
  });

  it('adds a row with an empty string value', () => {
    const onChange = vi.fn();
    render(<ItemsInput value={[]} onChange={onChange} />);

    fireEvent.click(screen.getByTitle('Add item'));

    expect(onChange).toHaveBeenCalledWith([{ label: '', value: '' }]);
  });
});

describe('ItemsInput — number values', () => {
  it('stores a real number for an integer list, not a numeric string', () => {
    const onChange = vi.fn();
    render(
      <ItemsInput valueType="integer" value={[{ label: 'Small', value: 0 }]} onChange={onChange} />,
    );

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '10' } });

    expect(onChange).toHaveBeenCalledWith([{ label: 'Small', value: 10 }]);
  });

  it('steps an integer cell by one and a float cell by any amount', () => {
    const { unmount } = render(
      <ItemsInput valueType="integer" value={[{ label: 'A', value: 1 }]} onChange={vi.fn()} />,
    );
    expect(screen.getByRole('spinbutton')).toHaveAttribute('step', '1');
    unmount();

    render(<ItemsInput valueType="float" value={[{ label: 'A', value: 1 }]} onChange={vi.fn()} />);
    expect(screen.getByRole('spinbutton')).toHaveAttribute('step', 'any');
  });

  it('keeps a fractional float value', () => {
    const onChange = vi.fn();
    render(
      <ItemsInput valueType="float" value={[{ label: 'Slow', value: 0 }]} onChange={onChange} />,
    );

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

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '' } });

    expect(onChange).toHaveBeenCalledWith([{ label: 'Small', value: undefined }]);
  });

  it('adds a number row at zero rather than at an empty string', () => {
    const onChange = vi.fn();
    render(<ItemsInput valueType="integer" value={[]} onChange={onChange} />);

    fireEvent.click(screen.getByTitle('Add item'));

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

    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));

    expect(onChange).toHaveBeenCalledWith([{ label: 'Forward', value: true }]);
  });

  it('adds a boolean row at false', () => {
    const onChange = vi.fn();
    render(<ItemsInput valueType="boolean" value={[]} onChange={onChange} />);

    fireEvent.click(screen.getByTitle('Add item'));

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

    fireEvent.change(screen.getByPlaceholderText('Search translations…'), {
      target: { value: 'motor' },
    });
    fireEvent.click(screen.getByRole('option', { name: /motor_on/i }));

    expect(onChange).toHaveBeenCalledWith([{ label: 'Running', value: { $loc: 'motor_on' } }]);
  });

  it('adds a localisable row with no key picked yet', () => {
    const onChange = vi.fn();
    render(<ItemsInput valueType="loc" value={[]} onChange={onChange} />);

    fireEvent.click(screen.getByTitle('Add item'));

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

    expect(screen.queryByPlaceholderText('Value')).not.toBeInTheDocument();
  });
});
