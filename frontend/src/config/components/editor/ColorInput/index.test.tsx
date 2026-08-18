import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ColorInput from './index';

describe('ColorInput', () => {
  // A field with no theme token behind it paints nothing, so the fallback names
  // that state rather than reading as an anonymous "Default".
  it('names the fallback "Transparent" when unset with no theme default', async () => {
    render(<ColorInput value={undefined} onChange={vi.fn()} />);
    expect(screen.getByText('Transparent')).toBeInTheDocument();
    expect(screen.getByText('· default')).toHaveClass('cfg-unset-hint');
    expect(screen.queryByTitle(/^Revert to /)).not.toBeInTheDocument();
  });

  it('names the fallback token, with the "default" suffix as a separate muted hint', () => {
    render(<ColorInput value={undefined} onChange={vi.fn()} defaultToken="--hmi-accent" />);
    expect(screen.getByText('Accent')).toBeInTheDocument();
    expect(screen.getByText('· default')).toHaveClass('cfg-unset-hint');
  });

  it('opens the popup listing theme colors and suggested colors', async () => {
    const user = userEvent.setup();
    render(<ColorInput value={undefined} onChange={vi.fn()} />);
    await user.click(screen.getByTitle('Falls back to transparent'));

    expect(screen.getByText('Theme colors')).toBeInTheDocument();
    expect(screen.getByText('Suggested colors')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Accent/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Electric Blue/ })).toBeInTheDocument();
    expect(screen.getByText('Custom…')).toBeInTheDocument();
  });

  it('picks a theme token, pinning the value to var(--hmi-*) and closing the popup', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ColorInput value={undefined} onChange={onChange} />);
    await user.click(screen.getByTitle('Falls back to transparent'));
    await user.click(screen.getByRole('button', { name: /Accent/ }));

    expect(onChange).toHaveBeenCalledWith('var(--hmi-accent)');
    expect(screen.queryByText('Theme colors')).not.toBeInTheDocument();
  });

  it('picks a suggested color as a fixed, non-theming hex value', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ColorInput value={undefined} onChange={onChange} />);
    await user.click(screen.getByTitle('Falls back to transparent'));
    await user.click(screen.getByRole('button', { name: /Electric Blue/ }));

    expect(onChange).toHaveBeenCalledWith('#2D9CFF');
  });

  it('previews the fallback token on the popup Default row, not a checkerboard', async () => {
    const user = userEvent.setup();
    render(<ColorInput value={undefined} onChange={vi.fn()} defaultToken="--hmi-ok" />);
    await user.click(screen.getByText('OK'));

    const row = screen.getByRole('button', { name: /^Default/ });
    const swatch = row.querySelector('.cfg-color-picker__swatch') as HTMLElement;
    expect(swatch).not.toHaveClass('cfg-color-picker__swatch--default');
    expect(swatch.style.backgroundColor).toBe('var(--hmi-ok)');
  });

  it('checkerboards the popup Default row only when the fallback is transparent', async () => {
    const user = userEvent.setup();
    render(<ColorInput value={undefined} onChange={vi.fn()} />);
    await user.click(screen.getByTitle('Falls back to transparent'));

    const row = screen.getByRole('button', { name: /^Default/ });
    expect(row.querySelector('.cfg-color-picker__swatch')).toHaveClass(
      'cfg-color-picker__swatch--default',
    );
  });

  it('picks Transparent as an explicit value', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ColorInput value={undefined} onChange={onChange} defaultToken="--hmi-accent" />);
    await user.click(screen.getByText('Accent'));
    await user.click(screen.getByRole('button', { name: /Transparent/ }));

    expect(onChange).toHaveBeenCalledWith('transparent');
  });

  // Explicit transparent and the no-token fallback look alike on purpose; only the
  // "· default" suffix and the revert action tell them apart.
  it('shows an explicitly picked Transparent as a plain value, with no suffix', () => {
    render(<ColorInput value="transparent" onChange={vi.fn()} />);
    expect(screen.getByText('Transparent')).toHaveClass('cfg-color-picker__label--has-value');
    expect(screen.queryByText('· default')).not.toBeInTheDocument();
    expect(screen.getByTitle('Revert to default (Transparent)')).toBeInTheDocument();
  });

  it('renders the pinned token label and swatch once a theme token is set', () => {
    render(<ColorInput value="var(--hmi-accent)" onChange={vi.fn()} />);
    expect(screen.getByText('Accent')).toBeInTheDocument();
  });

  // A manually picked theme token is an explicit value, not a fallback: it reads
  // as a normal value (no muted/"· default" treatment) even though it is themed.
  it('shows a manually picked theme token as a plain value, with no suffix', () => {
    render(<ColorInput value="var(--hmi-accent)" onChange={vi.fn()} defaultToken="--hmi-text" />);
    expect(screen.getByText('Accent')).toHaveClass('cfg-color-picker__label--has-value');
    expect(screen.queryByText('· default')).not.toBeInTheDocument();
  });

  it('renders the known palette name for a fixed hex that matches a suggested color', () => {
    render(<ColorInput value="#2D9CFF" onChange={vi.fn()} />);
    expect(screen.getByText('Electric Blue')).toBeInTheDocument();
  });

  it('reverts an override back to the theme default via the clear action', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ColorInput value="#2D9CFF" onChange={onChange} />);
    await user.click(screen.getByTitle('Revert to default (Transparent)'));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('does not show a revert action while unset', () => {
    render(<ColorInput value={undefined} onChange={vi.fn()} />);
    expect(screen.queryByTitle(/^Revert to /)).not.toBeInTheDocument();
  });

  it('drives the native <input type="color"> control directly', () => {
    const onChange = vi.fn();
    render(<ColorInput value="#2D9CFF" onChange={onChange} />);
    const nativeInput = document.querySelector('input[type="color"]') as HTMLInputElement;
    expect(nativeInput).toBeInTheDocument();
    expect(nativeInput.value.toLowerCase()).toBe('#2d9cff');

    // Simulate the OS color-picker committing a new value through the native control.
    fireEvent.change(nativeInput, { target: { value: '#123456' } });
    expect(onChange).toHaveBeenCalledWith('#123456');
  });

  it('hands off to the native color input and closes the popup when "Custom…" is picked', async () => {
    const user = userEvent.setup();
    render(<ColorInput value={undefined} onChange={vi.fn()} />);
    await user.click(screen.getByTitle('Falls back to transparent'));
    await user.click(screen.getByText('Custom…'));

    expect(screen.queryByText('Theme colors')).not.toBeInTheDocument();
  });

  it('reads "Mixed" over an unpainted swatch, with no fallback name and no revert', () => {
    render(<ColorInput value={undefined} onChange={vi.fn()} defaultToken="--hmi-accent" mixed />);
    const label = screen.getByText('Mixed');
    expect(label).toHaveClass('cfg-color-picker__label');
    expect(label).not.toHaveClass('cfg-color-picker__label--has-value');
    expect(screen.queryByText('Accent')).not.toBeInTheDocument();
    expect(screen.queryByText('· default')).not.toBeInTheDocument();
    expect(screen.queryByTitle(/^Revert to /)).not.toBeInTheDocument();
  });

  it('does not preselect the popup Default row while mixed', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ColorInput value={undefined} onChange={onChange} defaultToken="--hmi-accent" mixed />);
    await user.click(screen.getByText('Mixed'));

    expect(screen.getByRole('button', { name: /^Default/ })).not.toHaveClass(
      'cfg-color-picker__option--selected',
    );
    await user.click(screen.getByRole('button', { name: /Electric Blue/ }));
    expect(onChange).toHaveBeenCalledWith('#2D9CFF');
  });

  it('closes the popup via its own close button without changing the value', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ColorInput value={undefined} onChange={onChange} />);
    await user.click(screen.getByTitle('Falls back to transparent'));
    await user.click(screen.getByTitle('Close'));

    expect(screen.queryByText('Theme colors')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});
