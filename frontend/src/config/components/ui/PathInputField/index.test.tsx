import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PathInputField from './index';

function setup(overrides: Partial<Parameters<typeof PathInputField>[0]> = {}) {
  const onCommit = vi.fn();
  const onClear = vi.fn();
  render(<PathInputField value="plc:Speed" onCommit={onCommit} onClear={onClear} {...overrides} />);
  return { onCommit, onClear, input: screen.getByRole('textbox') };
}

describe('PathInputField', () => {
  it('does not commit while typing', () => {
    const { onCommit, input } = setup();
    fireEvent.change(input, { target: { value: 'plc:Torque' } });

    expect(onCommit).not.toHaveBeenCalled();
    expect(input).toHaveValue('plc:Torque');
  });

  it('commits the typed text on blur', () => {
    const { onCommit, input } = setup();
    fireEvent.change(input, { target: { value: 'plc:Torque' } });
    fireEvent.blur(input);

    expect(onCommit).toHaveBeenCalledWith('plc:Torque');
  });

  it('commits on Enter', () => {
    const { onCommit, input } = setup();
    fireEvent.change(input, { target: { value: 'plc:Torque' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);

    expect(onCommit).toHaveBeenCalledWith('plc:Torque');
  });

  it('reverts to the committed value on Escape without committing', () => {
    const { onCommit, input } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'plc:Torque' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.blur(input);

    expect(onCommit).not.toHaveBeenCalled();
    expect(input).toHaveValue('plc:Speed');
  });

  it('clears without committing the draft the blur would otherwise flush', () => {
    const { onCommit, onClear, input } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'half-typed' } });

    // Mousedown on the clear button blurs the still-focused input before the
    // button's own click runs — the guard must swallow that blur.
    const clear = screen.getByTitle('Clear');
    fireEvent.mouseDown(clear);
    fireEvent.blur(input);
    fireEvent.click(clear);

    expect(onCommit).not.toHaveBeenCalled();
    expect(onClear).toHaveBeenCalled();
  });

  it('follows the committed value down to empty even while focused', () => {
    // Regression: clearing unmounts the clear button, the browser hands focus
    // back to the input, and a focus-gated sync would then strand the draft on
    // the deleted value — which the next blur would commit straight back.
    const onCommit = vi.fn();
    const { rerender } = render(<PathInputField value="images/logo.svg" onCommit={onCommit} />);
    const input = screen.getByRole('textbox');

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'half-typed' } });

    // The owner clears the value while the input still holds focus.
    rerender(<PathInputField value="" onCommit={onCommit} />);
    expect(input).toHaveValue('');

    // ...and blurring now must not resurrect the stale draft.
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalledWith('half-typed');
  });

  it('does not clobber the draft when the committed value is unchanged', () => {
    const onCommit = vi.fn();
    const { rerender } = render(<PathInputField value="plc:Speed" onCommit={onCommit} />);
    const input = screen.getByRole('textbox');

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'plc:Torque' } });
    rerender(<PathInputField value="plc:Speed" onCommit={onCommit} />);

    expect(input).toHaveValue('plc:Torque');
  });

  it('renders the pick button only when a picker is wired up', () => {
    const { unmount } = render(<PathInputField value="" onCommit={vi.fn()} />);
    expect(screen.queryByTitle('Change')).not.toBeInTheDocument();
    unmount();

    render(<PathInputField value="" onCommit={vi.fn()} onPick={vi.fn()} pickTitle="Pick image" />);
    expect(screen.getByTitle('Pick image')).toBeInTheDocument();
  });

  it('renders a prefix against the live draft, not the committed value', () => {
    render(
      <PathInputField
        value="gear"
        onCommit={vi.fn()}
        renderPrefix={(draft) => <span data-testid="glyph">{draft}</span>}
      />,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'gauge' } });

    expect(screen.getByTestId('glyph')).toHaveTextContent('gauge');
  });
});
