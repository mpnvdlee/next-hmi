import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import ComponentPropertiesEditor from './ComponentPropertiesEditor';
import {
  renameComponentPropertyReferences,
  type ComponentPropertySchema,
} from '@shared/types/componentProperty';

const properties: Record<string, ComponentPropertySchema> = {
  motorSpeed: { type: 'float', label: 'Motor speed' },
};

describe('ComponentPropertiesEditor', () => {
  it('states the key and type but does not offer them for editing', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ComponentPropertiesEditor properties={properties} onChange={onChange} />);

    await user.click(screen.getByText('Motor speed'));

    expect(screen.getByText('motorSpeed')).toBeInTheDocument();
    expect(screen.getByText('float')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('motorSpeed')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('float')).not.toBeInTheDocument();
  });

  it('edits the label without touching the key', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ComponentPropertiesEditor properties={properties} onChange={onChange} />);

    await user.click(screen.getByText('Motor speed'));
    await user.type(screen.getByDisplayValue('Motor speed'), '!');

    expect(onChange).toHaveBeenCalledWith({
      motorSpeed: { type: 'float', label: 'Motor speed!' },
    });
  });

  it('marks a property as needing write access', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ComponentPropertiesEditor properties={properties} onChange={onChange} />);

    await user.click(screen.getByText('Motor speed'));
    const row = screen.getByText('Write access').closest('.cfg-field-group') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Yes' }));

    expect(onChange).toHaveBeenCalledWith({
      motorSpeed: { type: 'float', label: 'Motor speed', write: true },
    });
  });

  it('offers no write-access toggle for a struct property, which declares it per field', async () => {
    const user = userEvent.setup();
    render(
      <ComponentPropertiesEditor
        properties={{ motor: { type: 'struct', label: 'Motor', structSchema: [] } }}
        onChange={vi.fn()}
      />,
    );

    await user.click(screen.getByText('Motor'));

    expect(screen.queryByText('Write access')).not.toBeInTheDocument();
  });

  it('adds a property with the default given in the add dialog', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ComponentPropertiesEditor properties={{}} onChange={onChange} />);

    await user.click(screen.getByTitle('Add component property'));
    await user.type(screen.getByPlaceholderText('e.g. motorVar'), 'title');
    const row = screen.getByText('Default value').closest('.cfg-field-group') as HTMLElement;
    await user.type(within(row).getByRole('textbox'), 'Boiler');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(onChange).toHaveBeenCalledWith({
      title: { type: 'string', label: 'title', defaultValue: 'Boiler' },
    });
  });

  it('adds no default when the add dialog leaves it empty', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ComponentPropertiesEditor properties={{}} onChange={onChange} />);

    await user.click(screen.getByTitle('Add component property'));
    await user.type(screen.getByPlaceholderText('e.g. motorVar'), 'title');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(onChange).toHaveBeenCalledWith({ title: { type: 'string', label: 'title' } });
  });

  it('updates component-property references, including a struct path', () => {
    expect(
      renameComponentPropertyReferences(
        { actions: [{ value: { $componentProp: 'motorSpeed/actual' } }] },
        'motorSpeed',
        'lineSpeed',
      ),
    ).toEqual({ actions: [{ value: { $componentProp: 'lineSpeed/actual' } }] });
  });
});

/** A `select` used to hold string options and nothing else. The kind decides
 *  what the option list writes — and an option of the wrong kind is worse than
 *  no option, so switching kinds empties the values it can no longer describe. */
describe('ComponentPropertiesEditor — select option values', () => {
  beforeEach(() => {
    // jsdom doesn't implement scrollIntoView; the Select popup's active-option effect calls it.
    Element.prototype.scrollIntoView = vi.fn();
  });

  function selectProperty(extra: Partial<ComponentPropertySchema> = {}) {
    return {
      mode: {
        type: 'select',
        label: 'Mode',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: 'Manual', value: 'manual' },
        ],
        ...extra,
      } as ComponentPropertySchema,
    };
  }

  async function pickKind(properties: Record<string, ComponentPropertySchema>, kind: string) {
    cleanup();
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ComponentPropertiesEditor properties={properties} onChange={onChange} />);

    await user.click(screen.getByText('Mode'));
    const row = screen.getByText('Option values').closest('.cfg-field-group') as HTMLElement;
    await user.click(within(row).getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: kind }));

    return onChange.mock.calls[0]?.[0].mode as ComponentPropertySchema;
  }

  it('persists the kind an author picks', async () => {
    expect((await pickKind(selectProperty(), 'Integer')).optionType).toBe('integer');
    expect((await pickKind(selectProperty(), 'Localisable text')).optionType).toBe('loc');
  });

  // Absent reads as string, so an untouched select keeps the file it already has.
  it('writes no kind at all for String', async () => {
    const next = await pickKind(selectProperty({ optionType: 'integer' }), 'String');

    expect(next.optionType).toBeUndefined();
    expect(JSON.parse(JSON.stringify(next))).not.toHaveProperty('optionType');
  });

  it('clears stale option values but keeps their labels', async () => {
    const next = await pickKind(selectProperty(), 'Integer');

    expect(next.options).toEqual([
      { label: 'Auto', value: 0 },
      { label: 'Manual', value: 0 },
    ]);
  });

  it('empties each kind to its own blank value', async () => {
    expect((await pickKind(selectProperty(), 'Boolean')).options).toEqual([
      { label: 'Auto', value: false },
      { label: 'Manual', value: false },
    ]);
    expect((await pickKind(selectProperty({ optionType: 'integer' }), 'String')).options).toEqual([
      { label: 'Auto', value: '' },
      { label: 'Manual', value: '' },
    ]);
  });

  it('drops a default no remaining option can match', async () => {
    const next = await pickKind(selectProperty({ defaultValue: 'auto' }), 'Integer');

    expect(next.defaultValue).toBeUndefined();
  });

  it('keeps a default the emptied options still match', async () => {
    const next = await pickKind(
      selectProperty({ defaultValue: 0, optionType: 'float' }),
      'Integer',
    );

    expect(next.defaultValue).toBe(0);
  });

  it('gives the option list a number cell once the kind is a number', async () => {
    const user = userEvent.setup();
    render(
      <ComponentPropertiesEditor
        properties={selectProperty({
          optionType: 'integer',
          options: [{ label: 'Small', value: 10 }],
        })}
        onChange={vi.fn()}
      />,
    );

    await user.click(screen.getByText('Mode'));
    const row = screen.getByText('Options').closest('.cfg-field-group') as HTMLElement;

    expect(within(row).getByRole('spinbutton')).toHaveValue(10);
  });
});
