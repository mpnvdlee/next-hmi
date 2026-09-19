import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  // A unit missing from the cycle is not merely unreachable: `nextUnit` reads
  // its `indexOf` of -1 as "start over", so one click rewrites the stored value
  // to px with nothing offering the unit back.
  it('cycles from an unlisted unit to px, with no way back', () => {
    const onChange = vi.fn();
    render(<>{renderSchemaField(LENGTH_SCHEMA, '50vh', onChange)}</>);
    expect(screen.getByTitle('Cycle unit')).toHaveTextContent('vh');
    fireEvent.click(screen.getByTitle('Cycle unit'));
    expect(onChange).toHaveBeenCalledWith('50px');
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
const VIDEO_SCHEMA: SchemaField = { type: 'video', label: 'Video' };

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

  it('puts "Mixed" in a video field\'s placeholder instead of its path prompt', () => {
    render(<>{renderSchemaField(VIDEO_SCHEMA, undefined, vi.fn(), undefined, true)}</>);
    expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', 'Mixed');
  });

  it('keeps the video path prompt when the field is merely unset', () => {
    render(<>{renderSchemaField(VIDEO_SCHEMA, undefined, vi.fn())}</>);
    expect(screen.getByRole('textbox')).toHaveAttribute(
      'placeholder',
      'videos/clip.mp4 or https://…',
    );
  });

  // A bare name would otherwise resolve against assets/images/ — the shared
  // asset resolver's fallback root, and the wrong folder for this field.
  it.each([
    ['clip.mp4', 'videos/clip.mp4'],
    ['videos/lines/clip.mp4', 'videos/lines/clip.mp4'],
    ['https://cdn.example.com/clip.mp4', 'https://cdn.example.com/clip.mp4'],
  ])('roots a typed video path (%s)', async (typed, stored) => {
    const onChange = vi.fn();
    render(<>{renderSchemaField(VIDEO_SCHEMA, undefined, onChange)}</>);

    await userEvent.type(screen.getByRole('textbox'), typed);
    await userEvent.tab();

    expect(onChange).toHaveBeenCalledWith({ $static: { path: stored } });
  });

  it('puts "Mixed" in a length field\'s placeholder instead of leaving it blank', () => {
    render(
      <>{renderSchemaField(LENGTH_SCHEMA_TOKEN_DEFAULT, undefined, vi.fn(), undefined, true)}</>,
    );
    expect(screen.getByRole('spinbutton')).toHaveAttribute('placeholder', 'Mixed');
    expect(screen.queryByText(/· default/)).not.toBeInTheDocument();
  });
});

// A component property declares its default as a plain value — there is no
// `defaultToken` on it — so every one of these reaches the field that way.
describe('renderSchemaField — defaults declared as a value', () => {
  it('names a var(--hmi-*) color default as its theme token', () => {
    const schema: SchemaField = { type: 'color', label: 'Bar', defaultValue: 'var(--hmi-accent)' };
    render(<>{renderSchemaField(schema, undefined, vi.fn())}</>);
    expect(screen.getByText('Accent')).toBeInTheDocument();
    expect(screen.queryByText('Transparent')).not.toBeInTheDocument();
    expect(screen.getByText('· default')).toHaveClass('cfg-unset-hint');
  });

  it('names a literal color default instead of reading as transparent', () => {
    const schema: SchemaField = { type: 'color', label: 'Bar', defaultValue: '#2D9CFF' };
    render(<>{renderSchemaField(schema, undefined, vi.fn())}</>);
    expect(screen.getByText('Electric Blue')).toBeInTheDocument();
    expect(screen.getByTitle('Falls back to #2D9CFF')).toBeInTheDocument();
  });

  it('previews an icon default in the placeholder while unset', () => {
    const schema: SchemaField = {
      type: 'icon',
      label: 'Icon',
      defaultValue: { $static: { type: 'builtin', name: 'gear' } },
    };
    render(<>{renderSchemaField(schema, undefined, vi.fn())}</>);
    expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', 'gear · default');
  });

  it('shows the set icon, not the default, once overridden', () => {
    const schema: SchemaField = {
      type: 'icon',
      label: 'Icon',
      defaultValue: { $static: { type: 'builtin', name: 'gear' } },
    };
    render(
      <>{renderSchemaField(schema, { $static: { type: 'builtin', name: 'play' } }, vi.fn())}</>,
    );
    expect(screen.getByRole('textbox')).toHaveValue('play');
  });

  it('previews an image default in the placeholder while unset', () => {
    const schema: SchemaField = {
      type: 'image',
      label: 'Image',
      defaultValue: { $static: { path: 'images/pump.svg' } },
    };
    render(<>{renderSchemaField(schema, undefined, vi.fn())}</>);
    expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', 'images/pump.svg · default');
  });

  it('previews a video default in the placeholder while unset', () => {
    const schema: SchemaField = {
      type: 'video',
      label: 'Video',
      defaultValue: { $static: { path: 'videos/intro.mp4' } },
    };
    render(<>{renderSchemaField(schema, undefined, vi.fn())}</>);
    expect(screen.getByRole('textbox')).toHaveAttribute(
      'placeholder',
      'videos/intro.mp4 · default',
    );
  });
});

const LOC_SELECT: SchemaField = {
  type: 'string',
  format: 'select',
  label: 'Caption',
  options: [
    { label: 'Running', value: { $loc: 'status.running' } },
    { label: 'Stopped', value: { $loc: 'status.stopped' } },
  ],
};
const INT_SELECT: SchemaField = {
  type: 'integer',
  format: 'select',
  label: 'Size',
  options: [
    { label: 'Small', value: 10 },
    { label: 'Large', value: 20 },
  ],
};

// Every option used to be keyed and compared by `String(value)`, which collapses
// every `{ $loc }` to `[object Object]`: two translations became one option, and
// the dropdown could never tell which of them was selected.
describe('renderSchemaField — select options that are not strings', () => {
  beforeEach(() => {
    // jsdom doesn't implement scrollIntoView; the popup's active-option effect calls it.
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('keeps two translated options apart', async () => {
    render(<>{renderSchemaField(LOC_SELECT, { $loc: 'status.stopped' }, vi.fn())}</>);

    await userEvent.click(screen.getByRole('combobox'));

    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Running', 'Stopped']);
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'true']);
  });

  it('writes the picked translation verbatim, not a stringified one', async () => {
    const onChange = vi.fn();
    render(<>{renderSchemaField(LOC_SELECT, undefined, onChange)}</>);

    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(screen.getByRole('option', { name: 'Stopped' }));

    expect(onChange).toHaveBeenCalledWith({ $loc: 'status.stopped' });
  });

  it('shows the stored translation as the selected option', () => {
    render(<>{renderSchemaField(LOC_SELECT, { $loc: 'status.stopped' }, vi.fn())}</>);

    expect(screen.getByRole('combobox')).toHaveTextContent('Stopped');
  });

  // Asserting the *first* option would pass against the old `String()` keying
  // too: every `{ $loc }` collapsed to one key and `Select` picks the first
  // match. Only the second option tells the two implementations apart.
  it('reads a translation through a $static wrapper without stringifying it', () => {
    render(<>{renderSchemaField(LOC_SELECT, { $static: { $loc: 'status.stopped' } }, vi.fn())}</>);

    const trigger = screen.getByRole('combobox');
    expect(trigger).toHaveTextContent('Stopped');
    expect(trigger).not.toHaveTextContent('Running');
  });

  it('writes a numeric option as a number, not as its digits', async () => {
    const onChange = vi.fn();
    render(<>{renderSchemaField(INT_SELECT, undefined, onChange)}</>);

    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(screen.getByRole('option', { name: 'Large' }));

    expect(onChange).toHaveBeenCalledWith(20);
  });

  it('marks a numeric default on a button group by the number it is', () => {
    const schema: SchemaField = { ...INT_SELECT, display: 'button-text', defaultValue: 20 };
    render(<>{renderSchemaField(schema, undefined, vi.fn())}</>);

    expect(screen.getByRole('button', { name: 'Large' })).toHaveClass('cfg-seg-btn--default');
    expect(screen.getByRole('button', { name: 'Small' })).toHaveClass('cfg-seg-btn--alt');
  });
});

/** An option row is authored label-first: the value cell is filled in after,
 *  and a cleared number cell or an unpicked translation leaves the row with no
 *  value at all. `selectOptionKey` keys that as `''` — the very key an unset
 *  field carries — so such a row would read as the current selection of every
 *  instance that never set the property, and two of them would collide with
 *  each other. The row stays in the authoring list; it just isn't offered. */
describe('renderSchemaField — half-authored select options', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  const PARTIAL_INT_SELECT: SchemaField = {
    type: 'integer',
    format: 'select',
    label: 'Size',
    options: [{ label: 'Small' }, { label: 'Large', value: 20 }],
  };

  it('does not present a value-less row as the selection of an unset field', async () => {
    render(<>{renderSchemaField(PARTIAL_INT_SELECT, undefined, vi.fn())}</>);

    expect(screen.getByRole('combobox')).not.toHaveTextContent('Small');
  });

  it('offers only the rows that carry a value', async () => {
    render(<>{renderSchemaField(PARTIAL_INT_SELECT, undefined, vi.fn())}</>);

    await userEvent.click(screen.getByRole('combobox'));

    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Large']);
  });

  // Two of them key identically, which is the `[object Object]` collision again
  // — this time on the empty key rather than on the object one.
  it('offers neither of two unpicked translation rows', async () => {
    const schema: SchemaField = {
      ...LOC_SELECT,
      options: [{ label: 'Running' }, { label: 'Stopped' }],
    };
    render(<>{renderSchemaField(schema, undefined, vi.fn())}</>);

    await userEvent.click(screen.getByRole('combobox'));

    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('keeps a button group free of value-less options too', () => {
    const schema: SchemaField = { ...PARTIAL_INT_SELECT, display: 'button-text' };
    render(<>{renderSchemaField(schema, undefined, vi.fn())}</>);

    expect(screen.queryByRole('button', { name: 'Small' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Large' })).toBeInTheDocument();
  });
});

/** The hint under an unset field names the value it falls back to. `String()`
 *  on a translated option writes `[object Object]` into the tooltip and into
 *  the revert button's title, wherever the component is placed. */
describe('renderSchemaField — default hint for a non-string option', () => {
  it('names the default option by its label, not by stringifying its value', () => {
    const schema: SchemaField = { ...LOC_SELECT, defaultValue: { $loc: 'status.stopped' } };

    expect(resolveDefaultDisplay(schema)).toEqual({ text: 'Stopped', suffix: 'default' });
  });

  it('puts that label in the unset hint the editor shows', () => {
    const schema: SchemaField = { ...LOC_SELECT, defaultValue: { $loc: 'status.stopped' } };
    render(<>{renderSchemaField(schema, undefined, vi.fn())}</>);

    expect(screen.getByTitle('Falls back to Stopped')).toBeInTheDocument();
  });

  it('offers the revert affordance under the same label once overridden', () => {
    const schema: SchemaField = { ...LOC_SELECT, defaultValue: { $loc: 'status.stopped' } };
    render(<>{renderSchemaField(schema, { $loc: 'status.running' }, vi.fn())}</>);

    expect(screen.getByTitle('Revert to default (Stopped)')).toBeInTheDocument();
  });

  it('still stringifies a plain default that matches no option', () => {
    const schema: SchemaField = { ...INT_SELECT, defaultValue: 99 };

    expect(resolveDefaultDisplay(schema)).toEqual({ text: '99', suffix: 'default' });
  });

  it('shows no hint at all for a translated default that matches no option', () => {
    // `String()` here is the very `[object Object]` this describe block exists
    // to keep out of the tooltip, and no option lends it a label.
    const schema: SchemaField = { ...LOC_SELECT, defaultValue: { $loc: 'status.gone' } };

    expect(resolveDefaultDisplay(schema)).toBeNull();
    render(<>{renderSchemaField(schema, undefined, vi.fn())}</>);
    expect(screen.queryByTitle(/object Object/)).toBeNull();
  });
});
