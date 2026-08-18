import { fireEvent, render, screen } from '@testing-library/react';
import CloseButton from './index';

describe('CloseButton', () => {
  it('uses the shared close glyph and accessible default label', () => {
    render(<CloseButton />);

    const button = screen.getByRole('button', { name: 'Close' });
    expect(button).toHaveTextContent('×');
    expect(button).toHaveAttribute('type', 'button');
  });

  it('supports contextual labels and click handlers', () => {
    const onClick = vi.fn();
    render(<CloseButton tone="config" label="Dismiss warnings" onClick={onClick} />);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss warnings' }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
