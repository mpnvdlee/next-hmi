import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ItemListInput from './ItemListInput';

describe('ItemListInput', () => {
  it('opens records with fields of their own as JSON and saves a valid list', () => {
    const onChange = vi.fn();
    render(<ItemListInput value={[{ x: 0.1, y: 0.2, side: 'top' }]} onChange={onChange} />);

    const text = screen.getByRole('textbox');
    fireEvent.change(text, { target: { value: '[{"x": 0.5, "y": 0.5, "device": 3}]' } });

    expect(onChange).toHaveBeenCalledWith([{ x: 0.5, y: 0.5, device: 3 }]);
  });

  it('keeps what does not parse as a list out of the property', () => {
    const onChange = vi.fn();
    render(<ItemListInput value={[{ x: 0.1, y: 0.2 }]} onChange={onChange} />);

    const text = screen.getByRole('textbox');
    fireEvent.change(text, { target: { value: '[{"x": 0.5,' } });
    fireEvent.change(text, { target: { value: '{"x": 0.5}' } });

    expect(onChange).not.toHaveBeenCalled();
    expect(text).toHaveValue('{"x": 0.5}');
    expect(screen.getByText(/not a JSON list/)).toBeInTheDocument();
  });

  it('opens label / value rows as rows, and switches to JSON on request', () => {
    render(<ItemListInput value={[{ label: 'Auto', value: 'auto' }]} onChange={vi.fn()} />);

    expect(screen.getByDisplayValue('Auto')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Edit as JSON'));
    expect(screen.getByRole('textbox')).toHaveValue(
      JSON.stringify([{ label: 'Auto', value: 'auto' }], null, 2),
    );
  });
});
