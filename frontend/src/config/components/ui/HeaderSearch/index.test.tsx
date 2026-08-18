import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import HeaderSearch from './index';

describe('HeaderSearch', () => {
  it('updates and clears the search value', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <HeaderSearch value="" onChange={onChange} ariaLabel="Search translations" />,
    );

    const input = screen.getByRole('searchbox', { name: 'Search translations' });
    fireEvent.change(input, { target: { value: 'motor' } });
    expect(onChange).toHaveBeenLastCalledWith('motor');

    rerender(<HeaderSearch value="motor" onChange={onChange} ariaLabel="Search translations" />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear search translations' }));
    expect(onChange).toHaveBeenLastCalledWith('');
  });

  it('clears and blurs on Escape', () => {
    const onChange = vi.fn();
    render(<HeaderSearch value="motor" onChange={onChange} />);

    const input = screen.getByRole('searchbox', { name: 'Search' });
    input.focus();
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onChange).toHaveBeenLastCalledWith('');
    expect(input).not.toHaveFocus();
  });

  it('shows the slash shortcut and focuses the search from the keyboard', async () => {
    render(<HeaderSearch value="" onChange={vi.fn()} ariaLabel="Search translations" />);

    const input = screen.getByRole('searchbox', { name: 'Search translations' });
    expect(screen.getByText('/')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: '/' });

    await waitFor(() => expect(input).toHaveFocus());
  });

  it('does not handle the slash shortcut while typing in another field', () => {
    render(
      <>
        <input aria-label="Other field" />
        <HeaderSearch value="" onChange={vi.fn()} />
      </>,
    );

    const otherInput = screen.getByRole('textbox', { name: 'Other field' });
    otherInput.focus();
    fireEvent.keyDown(otherInput, { key: '/' });

    expect(screen.getByRole('searchbox', { name: 'Search' })).not.toHaveFocus();
    expect(otherInput).toHaveFocus();
  });
});
