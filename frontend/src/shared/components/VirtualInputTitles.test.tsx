import { render, screen } from '@testing-library/react';
import { VirtualKeyboard } from './VirtualKeyboard';
import { VirtualNumpad } from './VirtualNumpad';

describe('virtual input titles', () => {
  it('does not show a fallback title when the numpad has no label', () => {
    render(<VirtualNumpad isOpen value="" onChange={() => undefined} onClose={() => undefined} />);

    expect(screen.queryByText('Numpad')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Close numpad')).toBeInTheDocument();
  });

  it('shows a supplied numpad label', () => {
    render(
      <VirtualNumpad
        isOpen
        value=""
        onChange={() => undefined}
        onClose={() => undefined}
        title="Setpoint"
      />,
    );

    expect(screen.getByText('Setpoint')).toBeInTheDocument();
  });

  it('only shows a keyboard title when a label is supplied', () => {
    const { rerender } = render(
      <VirtualKeyboard isOpen value="" onChange={() => undefined} onClose={() => undefined} />,
    );

    expect(screen.queryByText('Keyboard')).not.toBeInTheDocument();

    rerender(
      <VirtualKeyboard
        isOpen
        value=""
        onChange={() => undefined}
        onClose={() => undefined}
        title="Operator name"
      />,
    );

    expect(screen.getByText('Operator name')).toBeInTheDocument();
  });
});
