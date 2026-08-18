import { render, screen, within } from '@testing-library/react';
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
