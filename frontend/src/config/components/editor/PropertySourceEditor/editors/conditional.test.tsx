import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SchemaField } from '@shared/types/widgetSchema';
import type { VariableBinding } from '@shared/types/config';
import { CompareEditor, IfEditor, SwitchEditor } from './conditional';
import type { OpenBindingPicker } from './utils';

// jsdom doesn't implement scrollIntoView; Select's popup calls it to keep the
// active option in view once opened.
Element.prototype.scrollIntoView = vi.fn();

const STRING_SCHEMA: SchemaField = { type: 'string', label: 'Value' };

/** Scope a query to the `.cfg-field-group` owning a given slot label
 *  (Condition / When True / Expression / …), same pattern as
 *  actionEditors.test.tsx's `openPlacementSelect`. */
function fieldGroup(label: string): HTMLElement {
  return screen.getByText(label).closest('.cfg-field-group') as HTMLElement;
}

describe('IfEditor', () => {
  function Harness({
    initial,
    onChange,
    schema,
    onOpenBindingPicker,
  }: {
    initial?: unknown;
    onChange: (v: unknown) => void;
    schema?: SchemaField;
    onOpenBindingPicker?: OpenBindingPicker;
  }) {
    const [value, setValue] = useState(initial);
    return (
      <IfEditor
        value={value}
        onChange={(v) => {
          onChange(v);
          setValue(v);
        }}
        schema={schema}
        onOpenBindingPicker={onOpenBindingPicker}
      />
    );
  }

  it('renders Condition/When True/When False rows when a value schema is given', () => {
    render(<Harness onChange={vi.fn()} schema={STRING_SCHEMA} />);
    expect(screen.getByText('Condition')).toBeInTheDocument();
    expect(screen.getByText('When True')).toBeInTheDocument();
    expect(screen.getByText('When False')).toBeInTheDocument();
  });

  it('omits the true/false branches when used without a value schema (routing-only usage)', () => {
    render(<Harness onChange={vi.fn()} />);
    expect(screen.getByText('Condition')).toBeInTheDocument();
    expect(screen.queryByText('When True')).not.toBeInTheDocument();
    expect(screen.queryByText('When False')).not.toBeInTheDocument();
  });

  it('sets a static boolean condition from the Yes/No control', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} schema={STRING_SCHEMA} />);
    await user.click(within(fieldGroup('Condition')).getByRole('button', { name: 'Yes' }));

    expect(onChange).toHaveBeenCalledWith({ $if: { condition: true, true: '', false: '' } });
  });

  it('types a static value into the "When True" branch', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} schema={STRING_SCHEMA} />);
    const input = within(fieldGroup('When True')).getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Running' } });

    expect(onChange).toHaveBeenCalledWith({
      $if: { condition: null, true: 'Running', false: '' },
    });
  });

  it('types a static value into the "When False" branch', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} schema={STRING_SCHEMA} />);
    const input = within(fieldGroup('When False')).getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Stopped' } });

    expect(onChange).toHaveBeenCalledWith({
      $if: { condition: null, true: '', false: 'Stopped' },
    });
  });

  it('switches the condition to $var and routes the picker through the outer callback', async () => {
    const onChange = vi.fn();
    const onOpenBindingPicker = vi.fn();
    const user = userEvent.setup();
    render(
      <Harness
        onChange={onChange}
        schema={STRING_SCHEMA}
        onOpenBindingPicker={onOpenBindingPicker}
      />,
    );

    await user.click(within(fieldGroup('Condition')).getByRole('button', { name: /Static/ }));
    await user.click(screen.getByRole('button', { name: /Variable/ }));

    expect(onChange).toHaveBeenLastCalledWith({
      $if: { condition: { $var: { path: '' } }, true: '', false: '' },
    });

    await user.click(
      within(fieldGroup('Condition')).getByRole('button', { name: 'Change variable binding' }),
    );
    expect(onOpenBindingPicker).toHaveBeenCalled();
    const pick = onOpenBindingPicker.mock.calls[0][0] as (b: VariableBinding) => void;
    pick({ path: 'PLC:Running' });

    expect(onChange).toHaveBeenLastCalledWith({
      $if: { condition: { $var: { path: 'PLC:Running' } }, true: '', false: '' },
    });
  });

  it('opens the picker preselected on the binding the branch already holds', () => {
    const onOpenBindingPicker = vi.fn();
    render(
      <Harness
        initial={{
          $if: { condition: null, true: { $var: { path: 'PLC:Fast' } }, false: '' },
        }}
        onChange={vi.fn()}
        schema={STRING_SCHEMA}
        onOpenBindingPicker={onOpenBindingPicker}
      />,
    );

    fireEvent.click(
      within(fieldGroup('When True')).getByRole('button', { name: 'Change variable binding' }),
    );

    // Second argument is `currentBinding` — the branch's own $var, which the
    // opener cannot read back off the property's top-level value.
    expect(onOpenBindingPicker.mock.calls[0][1]).toEqual({ path: 'PLC:Fast' });
  });

  it('leaves currentBinding undefined for a branch that holds no binding yet', () => {
    const onOpenBindingPicker = vi.fn();
    render(
      <Harness
        initial={{ $if: { condition: { $var: { path: '' } }, true: '', false: '' } }}
        onChange={vi.fn()}
        schema={STRING_SCHEMA}
        onOpenBindingPicker={onOpenBindingPicker}
      />,
    );

    fireEvent.click(
      within(fieldGroup('Condition')).getByRole('button', { name: 'Change variable binding' }),
    );

    expect(onOpenBindingPicker.mock.calls[0][1]).toBeUndefined();
  });

  it('does not crash and recovers to the default shape when given a malformed $if payload', () => {
    const onChange = vi.fn();
    render(<Harness initial={{ $if: null }} onChange={onChange} schema={STRING_SCHEMA} />);
    // Falls back to the documented default object rather than throwing.
    expect(screen.getByText('Condition')).toBeInTheDocument();
    expect(screen.getByText('When True')).toBeInTheDocument();
  });
});

describe('CompareEditor', () => {
  function Harness({
    initial,
    onChange,
    onOpenBindingPicker,
  }: {
    initial?: unknown;
    onChange: (v: unknown) => void;
    onOpenBindingPicker?: OpenBindingPicker;
  }) {
    const [value, setValue] = useState(initial);
    return (
      <CompareEditor
        value={value}
        onChange={(v) => {
          onChange(v);
          setValue(v);
        }}
        onOpenBindingPicker={onOpenBindingPicker}
      />
    );
  }

  it('defaults to a $var left operand, ">" operator, and a literal 0 right operand', () => {
    render(<Harness onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: '>' })).toHaveClass('cfg-operator-row__btn--active');
  });

  it('changes the operator and persists the full $compare shape', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: '=' }));

    expect(onChange).toHaveBeenCalledWith({
      $compare: { left: { $var: { path: '' } }, operator: '===', right: 0 },
    });
  });

  it('edits the right operand as a literal value', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const rightInput = within(fieldGroup('That value')).getByRole('textbox');
    fireEvent.change(rightInput, { target: { value: '42' } });

    expect(onChange).toHaveBeenCalledWith({
      $compare: { left: { $var: { path: '' } }, operator: '>', right: '42' },
    });
  });

  it('routes the left-operand variable picker through the outer callback', () => {
    const onChange = vi.fn();
    const onOpenBindingPicker = vi.fn();
    render(<Harness onChange={onChange} onOpenBindingPicker={onOpenBindingPicker} />);

    fireEvent.click(
      within(fieldGroup('This value')).getByRole('button', { name: 'Change variable binding' }),
    );
    expect(onOpenBindingPicker).toHaveBeenCalled();
    const pick = onOpenBindingPicker.mock.calls[0][0] as (b: VariableBinding) => void;
    pick({ path: 'PLC:Motor1/Speed' });

    expect(onChange).toHaveBeenLastCalledWith({
      $compare: { left: { $var: { path: 'PLC:Motor1/Speed' } }, operator: '>', right: 0 },
    });
  });

  it('preselects each operand picker on the binding that operand holds', () => {
    const onOpenBindingPicker = vi.fn();
    render(
      <Harness
        initial={{
          $compare: {
            left: { $var: { path: 'PLC:Speed' } },
            operator: '>',
            right: { $var: { path: 'PLC:Limit' } },
          },
        }}
        onChange={vi.fn()}
        onOpenBindingPicker={onOpenBindingPicker}
      />,
    );

    fireEvent.click(
      within(fieldGroup('This value')).getByRole('button', { name: 'Change variable binding' }),
    );
    expect(onOpenBindingPicker.mock.calls[0][1]).toEqual({ path: 'PLC:Speed' });

    fireEvent.click(
      within(fieldGroup('That value')).getByRole('button', { name: 'Change variable binding' }),
    );
    expect(onOpenBindingPicker.mock.calls[1][1]).toEqual({ path: 'PLC:Limit' });
  });

  it('recovers gracefully from a malformed $compare payload, falling back to the default shape', () => {
    render(<CompareEditor value={{ $compare: null }} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: '>' })).toBeInTheDocument();
  });
});

describe('SwitchEditor', () => {
  function Harness({
    initial,
    onChange,
    schema,
  }: {
    initial?: unknown;
    onChange: (v: unknown) => void;
    schema?: SchemaField;
  }) {
    const [value, setValue] = useState(initial);
    return (
      <SwitchEditor
        value={value}
        onChange={(v) => {
          onChange(v);
          setValue(v);
        }}
        schema={schema}
      />
    );
  }

  it('starts with no cases and shows the Default row when a schema is given', () => {
    render(<Harness onChange={vi.fn()} schema={STRING_SCHEMA} />);
    expect(screen.getByText('No cases yet')).toBeInTheDocument();
    expect(screen.getByText('Default')).toBeInTheDocument();
  });

  it('adds a case with the documented default shape and opens it', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} schema={STRING_SCHEMA} />);
    await user.click(screen.getByRole('button', { name: '+ Add case' }));

    expect(onChange).toHaveBeenCalledWith({
      $switch: { value: null, cases: [{ when: '', then: '' }], default: '' },
    });
    expect(screen.queryByText('No cases yet')).not.toBeInTheDocument();
    // The newly-added case opens immediately, ready to edit — and it edits in
    // place, inside the row itself.
    expect(screen.getByText('Case 1')).toBeInTheDocument();
    expect(screen.getByText('When')).toBeInTheDocument();
    expect(screen.getByText('Then')).toBeInTheDocument();
  });

  it('collapses a case row to a `when = then` preview and reopens it', async () => {
    const user = userEvent.setup();
    render(<Harness onChange={vi.fn()} schema={STRING_SCHEMA} />);
    await user.click(screen.getByRole('button', { name: '+ Add case' }));
    expect(screen.getByText('When')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Collapse' }));
    expect(screen.queryByText('When')).not.toBeInTheDocument();
    // Same shape the collapsed `$switch` field summary uses for a case.
    expect(screen.getByText('→')).toBeInTheDocument();
    expect(screen.getByText(/\(empty\)/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Expand' }));
    expect(screen.getByText('When')).toBeInTheDocument();
  });

  it('gives a case row the chevron only — no pop-out drawer button', async () => {
    const user = userEvent.setup();
    render(<Harness onChange={vi.fn()} schema={STRING_SCHEMA} />);
    await user.click(screen.getByRole('button', { name: '+ Add case' }));

    expect(screen.queryByRole('button', { name: 'Expand in drawer' })).not.toBeInTheDocument();
  });

  it('edits the When/Then fields of the selected case', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} schema={STRING_SCHEMA} />);
    fireEvent.click(screen.getByRole('button', { name: '+ Add case' }));

    fireEvent.change(within(fieldGroup('When')).getByRole('textbox'), {
      target: { value: 'running' },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      $switch: { value: null, cases: [{ when: 'running', then: '' }], default: '' },
    });

    fireEvent.change(within(fieldGroup('Then')).getByRole('textbox'), {
      target: { value: 'Motor running' },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      $switch: {
        value: null,
        cases: [{ when: 'running', then: 'Motor running' }],
        default: '',
      },
    });
  });

  it('removes a case and hides the When/Then fields again', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} schema={STRING_SCHEMA} />);
    await user.click(screen.getByRole('button', { name: '+ Add case' }));
    expect(screen.getByText('When')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove case' }));

    expect(onChange).toHaveBeenLastCalledWith({
      $switch: { value: null, cases: [], default: '' },
    });
    expect(screen.queryByText('When')).not.toBeInTheDocument();
    expect(screen.getByText('No cases yet')).toBeInTheDocument();
  });

  it('edits the top-level expression and the fallback Default branch', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} schema={STRING_SCHEMA} />);

    fireEvent.change(within(fieldGroup('Expression')).getByRole('textbox'), {
      target: { value: 'mode' },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      $switch: { value: 'mode', cases: [], default: '' },
    });

    fireEvent.change(within(fieldGroup('Default')).getByRole('textbox'), {
      target: { value: 'Unknown' },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      $switch: { value: 'mode', cases: [], default: 'Unknown' },
    });
  });

  it('recovers gracefully from a malformed $switch payload, falling back to the default shape', () => {
    render(<SwitchEditor value={{ $switch: null }} onChange={vi.fn()} schema={STRING_SCHEMA} />);
    expect(screen.getByText('No cases yet')).toBeInTheDocument();
  });
});
