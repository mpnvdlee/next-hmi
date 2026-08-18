import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentPropertySchema } from '@shared/types/componentProperty';
import { ComponentPropertySchemaContext } from '@config/components/editor/PropertySourceEditor/componentPropertySchemaContext';
import SlotNameField from './SlotNameField';

// jsdom doesn't implement scrollIntoView; the custom Select's popup calls it.
Element.prototype.scrollIntoView = vi.fn();

const DECLARED: Record<string, ComponentPropertySchema> = {
  title: { type: 'string', label: 'Title' },
  body: { type: 'widgets', label: 'Body' },
};

function renderField(
  value: string,
  properties: Record<string, ComponentPropertySchema> | null,
  onChange = vi.fn(),
) {
  render(
    <ComponentPropertySchemaContext.Provider value={properties ? { properties } : null}>
      <SlotNameField value={value} onChange={onChange} />
    </ComponentPropertySchemaContext.Provider>,
  );
  return onChange;
}

describe('SlotNameField', () => {
  it('offers the definition’s slot properties, and nothing else it declares', async () => {
    const user = userEvent.setup();
    renderField('', DECLARED);

    await user.click(screen.getByRole('combobox'));

    expect(screen.getByRole('option', { name: 'Body (body)' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Title/ })).not.toBeInTheDocument();
  });

  it('stores the property key it was given', async () => {
    const user = userEvent.setup();
    const onChange = renderField('', DECLARED);

    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'Body (body)' }));

    expect(onChange).toHaveBeenCalledWith('body');
  });

  it('keeps a name that matches no declaration selected, marked as undeclared', async () => {
    const user = userEvent.setup();
    renderField('content', DECLARED);

    expect(screen.getByRole('combobox')).toHaveTextContent('content (not declared)');

    await user.click(screen.getByRole('combobox'));
    expect(screen.getByRole('option', { name: 'Body (body)' })).toBeInTheDocument();
  });

  it('says what to declare when the component has no slot property yet', () => {
    renderField('content', { title: { type: 'string', label: 'Title' } });

    expect(screen.getByText(/Widget slot/)).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('content');
  });

  it('types the name outside a component scope, where nothing can be declared', async () => {
    const user = userEvent.setup();
    const onChange = renderField('', null);

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    await user.type(screen.getByRole('textbox'), 'b');

    expect(onChange).toHaveBeenCalledWith('b');
  });
});
