import { fireEvent, render, screen } from '@testing-library/react';
import CloseButton from './index';

describe('CloseButton', () => {
  it('uses the shared close glyph', () => {
    render(<CloseButton />);

    const button = screen.getByRole('button');
    expect(button).toHaveTextContent('×');
    expect(button).toHaveAttribute('type', 'button');
  });

  it('supports click handlers', () => {
    const onClick = vi.fn();
    render(<CloseButton tone="config" onClick={onClick} />);

    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
