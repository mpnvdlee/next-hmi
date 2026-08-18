import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { renderSchemaField, resolveDefaultDisplay } from './renderSchemaField';
import type { SchemaField } from '@shared/types/widgetSchema';

const LENGTH_SCHEMA: SchemaField = { type: 'string', label: 'Width', format: 'length' };

describe('renderSchemaField — format:"length"', () => {
  it('splits a stored value into number + unit', () => {
    render(<>{renderSchemaField(LENGTH_SCHEMA, '16px', vi.fn())}</>);
    expect(screen.getByRole('spinbutton')).toHaveValue(16);
    expect(screen.getByTitle('Cycle unit')).toHaveTextContent('px');
  });

  it('cycles the unit on each click of the unit toggle', () => {
    const onChange = vi.fn();
    render(<>{renderSchemaField(LENGTH_SCHEMA, '16px', onChange)}</>);
    fireEvent.click(screen.getByTitle('Cycle unit'));
    expect(onChange).toHaveBeenCalledWith('16%');
  });

  it('recombines number + unit into a string on number change', () => {
    const onChange = vi.fn();
    render(<>{renderSchemaField(LENGTH_SCHEMA, '16px', onChange)}</>);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '24' } });
    expect(onChange).toHaveBeenCalledWith('24px');
  });

  it('defaults a bare number typed on an unset value to px', () => {
    const onChange = vi.fn();
    render(<>{renderSchemaField(LENGTH_SCHEMA, undefined, onChange)}</>);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '8' } });
    expect(onChange).toHaveBeenCalledWith('8px');
  });

  it('recognizes "auto" and disables the number input', () => {
    render(<>{renderSchemaField(LENGTH_SCHEMA, 'auto', vi.fn())}</>);
    expect(screen.getByRole('spinbutton')).toBeDisabled();
    expect(screen.getByTitle('Cycle unit')).toHaveTextContent('auto');
  });

  it('cycling the unit with no magnitude yet only updates the toggle, without clearing the field', () => {
    const onChange = vi.fn();
    render(<>{renderSchemaField(LENGTH_SCHEMA, undefined, onChange)}</>);
    const toggle = screen.getByTitle('Cycle unit');
    fireEvent.click(toggle); // px -> %
    expect(onChange).not.toHaveBeenCalled();
    expect(toggle).toHaveTextContent('%');
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '5' } });
    expect(onChange).toHaveBeenCalledWith('5%');
  });

  it('cycling away from "auto" with no magnitude does not wipe the value back to unset', () => {
    const onChange = vi.fn();
    render(<>{renderSchemaField(LENGTH_SCHEMA, 'auto', onChange)}</>);
    fireEvent.click(screen.getByTitle('Cycle unit')); // auto -> px, num still empty
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTitle('Cycle unit')).toHaveTextContent('px');
  });

  it('clears to unset when the number is emptied', () => {
    const onChange = vi.fn();
    render(<>{renderSchemaField(LENGTH_SCHEMA, '16px', onChange)}</>);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('splits an unset magnitude default across the placeholder and the unit toggle', () => {
    const schema: SchemaField = { ...LENGTH_SCHEMA, defaultValue: 'var(--hmi-space-2)' };
    render(<>{renderSchemaField(schema, undefined, vi.fn(), { '--hmi-space-2': '0.5rem' })}</>);
    expect(screen.getByRole('spinbutton')).toHaveAttribute('placeholder', '0.5');
    expect(screen.getByTitle(/unit/)).toHaveTextContent('rem');
    expect(screen.getByText('· default(space-2)')).toBeInTheDocument();
  });

  it('falls back to "not set" when the default token resolves to nothing', () => {
    const schema: SchemaField = { ...LENGTH_SCHEMA, defaultToken: '--hmi-nope' };
    render(<>{renderSchemaField(schema, undefined, vi.fn(), { '--hmi-nope': '' })}</>);
    const input = screen.getByRole('spinbutton');
    // Hugging its placeholder is what keeps the suffix off the row's buttons.
    expect(input).toHaveAttribute('placeholder', 'not set');
    expect(input).toHaveClass('cfg-prop-input--hint');
  });

  it('shows a unitless default whole in the placeholder', () => {
    const schema: SchemaField = { ...LENGTH_SCHEMA, defaultValue: 'auto' };
    render(<>{renderSchemaField(schema, undefined, vi.fn())}</>);
    expect(screen.getByRole('spinbutton')).toHaveAttribute('placeholder', 'auto');
    expect(screen.getByText('· default')).toBeInTheDocument();
  });

  it('commits a magnitude typed against an "auto" default under a real unit', () => {
    const onChange = vi.fn();
    const schema: SchemaField = { ...LENGTH_SCHEMA, defaultValue: 'auto' };
    render(<>{renderSchemaField(schema, undefined, onChange)}</>);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '200' } });
    expect(onChange).toHaveBeenCalledWith('200px');
  });

  it('re-enables the number input after cycling away from a stored "auto"', () => {
    render(<>{renderSchemaField(LENGTH_SCHEMA, 'auto', vi.fn())}</>);
    fireEvent.click(screen.getByTitle('Cycle unit')); // auto -> px
    expect(screen.getByRole('spinbutton')).not.toBeDisabled();
  });
});

const INT_SCHEMA_WITH_DEFAULT: SchemaField = {
  type: 'integer',
  label: 'Decimal places',
  defaultValue: 2,
};
const STRING_SCHEMA_WITH_TOKEN_DEFAULT: SchemaField = {
  type: 'string',
  label: 'Accent',
  defaultValue: 'var(--hmi-accent)',
};
const INT_SCHEMA_NO_DEFAULT: SchemaField = { type: 'integer', label: 'Count' };

describe('renderSchemaField — unset→default hint', () => {
  it('places the default in the placeholder and its suffix in the muted hint span', () => {
    render(<>{renderSchemaField(INT_SCHEMA_WITH_DEFAULT, undefined, vi.fn())}</>);
    const input = screen.getByRole('spinbutton');
    expect(input).toHaveValue(null);
    expect(input).toHaveAttribute('placeholder', '2');
    expect(screen.getByText('· default')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '×' })).not.toBeInTheDocument();
  });

  it('shows a theme-token suffix and no hint text once overridden, with a × to revert', () => {
    const onChange = vi.fn();
    render(<>{renderSchemaField(STRING_SCHEMA_WITH_TOKEN_DEFAULT, 'Motor', onChange)}</>);
    expect(screen.getByDisplayValue('Motor')).toBeInTheDocument();
    expect(screen.queryByText('· default')).not.toBeInTheDocument();
    const revertBtn = screen.getByRole('button', { name: /Revert to/ });
    fireEvent.click(revertBtn);
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('adds no hint wrapper when the schema has no default to fall back to', () => {
    render(<>{renderSchemaField(INT_SCHEMA_NO_DEFAULT, undefined, vi.fn())}</>);
    expect(screen.queryByText('· default', { exact: false })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '×' })).not.toBeInTheDocument();
  });
});

describe('resolveDefaultDisplay', () => {
  it('resolves a bare defaultToken to a default(<label>) suffix', () => {
    const out = resolveDefaultDisplay({
      type: 'string',
      label: 'Gap',
      defaultToken: '--hmi-accent',
    });
    expect(out?.suffix).toBe('default(Accent)');
  });

  it('resolves a var(--hmi-*) defaultValue to a theme suffix too', () => {
    const out = resolveDefaultDisplay({
      type: 'string',
      label: 'Accent',
      defaultValue: 'var(--hmi-accent)',
    });
    expect(out?.suffix).toBe('default(Accent)');
  });

  it('resolves a plain defaultValue to the "default" suffix', () => {
    const out = resolveDefaultDisplay({ type: 'integer', label: 'Count', defaultValue: 2 });
    expect(out).toEqual({ text: '2', suffix: 'default' });
  });

  it('returns null when there is no meaningful default', () => {
    expect(resolveDefaultDisplay({ type: 'integer', label: 'Count' })).toBeNull();
  });
});

const LENGTH_SCHEMA_TOKEN_DEFAULT: SchemaField = {
  type: 'string',
  label: 'Gap',
  format: 'length',
  defaultToken: '--hmi-accent',
};

describe('renderSchemaField — themed default coverage', () => {
  it('greys the length unit toggle while unset with a themed default', () => {
    render(<>{renderSchemaField(LENGTH_SCHEMA_TOKEN_DEFAULT, undefined, vi.fn())}</>);
    const toggle = screen.getByTitle('Set a value to choose a unit');
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveClass('is-disabled');
    expect(screen.getByText(/· default\(/)).toBeInTheDocument();
  });

  it('re-enables the unit toggle once a value is typed', () => {
    render(<>{renderSchemaField(LENGTH_SCHEMA_TOKEN_DEFAULT, '16px', vi.fn())}</>);
    expect(screen.getByTitle('Cycle unit')).not.toBeDisabled();
  });
});

const BOOL_SCHEMA_DEFAULT_TRUE: SchemaField = {
  type: 'boolean',
  format: 'visibility',
  label: 'Visible',
  defaultValue: true,
};
const SELECT_SCHEMA_DEFAULT: SchemaField = {
  type: 'string',
  format: 'select',
  label: 'Alignment',
  display: 'button-text',
  defaultValue: 'center',
  options: [
    { label: 'Left', value: 'left' },
    { label: 'Center', value: 'center' },
    { label: 'Right', value: 'right' },
  ],
};

describe('renderSchemaField — bool/enum unset default marker', () => {
  it('marks the default boolean option and dims the other while unset', () => {
    render(<>{renderSchemaField(BOOL_SCHEMA_DEFAULT_TRUE, undefined, vi.fn())}</>);
    const visible = screen.getByRole('button', { name: 'Visible' });
    const hidden = screen.getByRole('button', { name: 'Hidden' });
    expect(visible).toHaveClass('cfg-seg-btn--default');
    expect(visible).not.toHaveClass('cfg-seg-btn--active');
    expect(hidden).toHaveClass('cfg-seg-btn--alt');
  });

  it('shows an explicit boolean selection as active, not a default marker', () => {
    render(<>{renderSchemaField(BOOL_SCHEMA_DEFAULT_TRUE, false, vi.fn())}</>);
    expect(screen.getByRole('button', { name: 'Hidden' })).toHaveClass('cfg-seg-btn--active');
    expect(screen.getByRole('button', { name: 'Visible' })).not.toHaveClass('cfg-seg-btn--default');
  });

  it('marks the default segmented option and dims the rest while unset', () => {
    render(<>{renderSchemaField(SELECT_SCHEMA_DEFAULT, undefined, vi.fn())}</>);
    expect(screen.getByRole('button', { name: 'Center' })).toHaveClass('cfg-seg-btn--default');
    expect(screen.getByRole('button', { name: 'Left' })).toHaveClass('cfg-seg-btn--alt');
    expect(screen.getByRole('button', { name: 'Right' })).toHaveClass('cfg-seg-btn--alt');
  });

  it('shows an explicit segmented selection as active', () => {
    render(<>{renderSchemaField(SELECT_SCHEMA_DEFAULT, 'right', vi.fn())}</>);
    const right = screen.getByRole('button', { name: 'Right' });
    expect(right).toHaveClass('cfg-seg-btn--active');
    expect(right).not.toHaveClass('cfg-seg-btn--alt');
  });
});

const SELECT_SCHEMA_DROPDOWN: SchemaField = {
  type: 'string',
  format: 'select',
  label: 'Alignment',
  defaultValue: 'center',
  options: [
    { label: '—', value: '' },
    { label: 'Left', value: 'left' },
    { label: 'Center', value: 'center' },
  ],
};
const COLOR_SCHEMA_TOKEN_DEFAULT: SchemaField = {
  type: 'color',
  label: 'Fill',
  defaultToken: '--hmi-accent',
};
const ICON_SCHEMA: SchemaField = { type: 'icon', label: 'Icon' };
const IMAGE_SCHEMA: SchemaField = { type: 'image', label: 'Image' };

describe('renderSchemaField — mixed multi-selection', () => {
  it('dims every boolean option and names the state, with no default marked', () => {
    render(<>{renderSchemaField(BOOL_SCHEMA_DEFAULT_TRUE, undefined, vi.fn(), undefined, true)}</>);
    expect(screen.getByRole('button', { name: 'Visible' })).toHaveClass('cfg-seg-btn--alt');
    expect(screen.getByRole('button', { name: 'Hidden' })).toHaveClass('cfg-seg-btn--alt');
    expect(screen.queryByText('· default')).not.toBeInTheDocument();
    expect(screen.getByText('Mixed')).toHaveClass('cfg-unset-hint');
  });

  it('dims every segmented option and names the state', () => {
    render(<>{renderSchemaField(SELECT_SCHEMA_DEFAULT, undefined, vi.fn(), undefined, true)}</>);
    for (const name of ['Left', 'Center', 'Right']) {
      const btn = screen.getByRole('button', { name });
      expect(btn).toHaveClass('cfg-seg-btn--alt');
      expect(btn).not.toHaveClass('cfg-seg-btn--default');
      expect(btn).not.toHaveClass('cfg-seg-btn--active');
    }
    expect(screen.getByText('Mixed')).toHaveClass('cfg-unset-hint');
  });

  it('picking an option from a mixed group still writes that option', () => {
    const onChange = vi.fn();
    render(<>{renderSchemaField(SELECT_SCHEMA_DEFAULT, undefined, onChange, undefined, true)}</>);
    fireEvent.click(screen.getByRole('button', { name: 'Left' }));
    expect(onChange).toHaveBeenCalledWith('left');
  });

  // The empty option would otherwise read as the current selection, which is
  // exactly the "nothing set" the mixed state must not be confused with.
  it('shows "Mixed" on a dropdown select rather than selecting its empty option', () => {
    render(<>{renderSchemaField(SELECT_SCHEMA_DROPDOWN, undefined, vi.fn(), undefined, true)}</>);
    const trigger = screen.getByRole('combobox');
    expect(trigger).toHaveTextContent('Mixed');
    expect(trigger.querySelector('.cfg-select__placeholder')).not.toBeNull();
  });

  it('reads "Mixed" on a color field instead of naming the theme fallback', () => {
    render(
      <>{renderSchemaField(COLOR_SCHEMA_TOKEN_DEFAULT, undefined, vi.fn(), undefined, true)}</>,
    );
    expect(screen.getByText('Mixed')).toBeInTheDocument();
    expect(screen.queryByText('Accent')).not.toBeInTheDocument();
    expect(screen.queryByText('· default')).not.toBeInTheDocument();
  });

  // An empty icon input is exactly how widgets with *no* icon read, so without
  // the word the panel claims agreement where there is none — and gives no
  // warning that picking one overwrites two different icons.
  it('puts "Mixed" in an icon field\'s placeholder instead of its name prompt', () => {
    render(<>{renderSchemaField(ICON_SCHEMA, undefined, vi.fn(), undefined, true)}</>);
    expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', 'Mixed');
  });

  it('keeps the icon name prompt when the field is merely unset', () => {
    render(<>{renderSchemaField(ICON_SCHEMA, undefined, vi.fn())}</>);
    expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', 'Icon name (e.g. gear)');
  });

  it('puts "Mixed" in an image field\'s placeholder instead of its path prompt', () => {
    render(<>{renderSchemaField(IMAGE_SCHEMA, undefined, vi.fn(), undefined, true)}</>);
    expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', 'Mixed');
  });

  it('keeps the image path prompt when the field is merely unset', () => {
    render(<>{renderSchemaField(IMAGE_SCHEMA, undefined, vi.fn())}</>);
    expect(screen.getByRole('textbox')).toHaveAttribute(
      'placeholder',
      'images/logo.svg or https://…',
    );
  });

  it('puts "Mixed" in a length field\'s placeholder instead of leaving it blank', () => {
    render(
      <>{renderSchemaField(LENGTH_SCHEMA_TOKEN_DEFAULT, undefined, vi.fn(), undefined, true)}</>,
    );
    expect(screen.getByRole('spinbutton')).toHaveAttribute('placeholder', 'Mixed');
    expect(screen.queryByText(/· default/)).not.toBeInTheDocument();
  });
});
