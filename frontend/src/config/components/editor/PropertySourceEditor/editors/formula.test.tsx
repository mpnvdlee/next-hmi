import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { FormulaEditor } from './formula';

function Harness({ initial, onChange }: { initial?: unknown; onChange: (v: unknown) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <FormulaEditor
      value={value}
      onChange={(v) => {
        onChange(v);
        setValue(v);
      }}
    />
  );
}

describe('FormulaEditor', () => {
  it('adds a card per placeholder and keeps existing bindings when the formula changes', () => {
    const onChange = vi.fn();
    const bound = { $var: { path: 'PLC:Temp' } };
    render(
      <Harness
        initial={{ $formula: { expression: '{1}', wildcards: { 1: bound } } }}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('({1} - 32) / 1.8'), {
      target: { value: '({1} - 32) / {2}' },
    });

    expect(onChange).toHaveBeenLastCalledWith({
      $formula: { expression: '({1} - 32) / {2}', wildcards: { 1: bound, 2: 0 } },
    });
    // Once in the syntax hint, once as the card title.
    expect(screen.getAllByText('{1}')).toHaveLength(2);
    expect(screen.getAllByText('{2}')).toHaveLength(2);
  });

  it('flags a formula that does not parse', () => {
    render(
      <Harness initial={{ $formula: { expression: '1 +', wildcards: {} } }} onChange={vi.fn()} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('not valid');
  });

  it('shows the syntax hint for a valid formula', () => {
    render(
      <Harness initial={{ $formula: { expression: '1 + 2', wildcards: {} } }} onChange={vi.fn()} />,
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
