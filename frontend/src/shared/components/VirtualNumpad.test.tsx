import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VirtualNumpad } from './VirtualNumpad';

function NumpadHarness({
  onClose = () => undefined,
  min,
  max,
}: {
  onClose?: (value: string) => void;
  min?: number;
  max?: number;
}) {
  const [value, setValue] = useState('');
  return (
    <>
      <output aria-label="Harness value">{value}</output>
      <VirtualNumpad
        isOpen
        value={value}
        onChange={setValue}
        onClose={onClose}
        min={min}
        max={max}
      />
    </>
  );
}

describe('VirtualNumpad', () => {
  it('types digits and commits on Enter', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<NumpadHarness onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: '4' }));
    await user.click(screen.getByRole('button', { name: '2' }));
    await user.click(screen.getByRole('button', { name: 'Enter' }));

    expect(screen.getByLabelText('Harness value')).toHaveTextContent('42');
    expect(onClose).toHaveBeenCalledWith('42');
  });

  it('disables Enter and cannot commit a value below min', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<NumpadHarness onClose={onClose} min={0} max={100} />);

    await user.click(screen.getByRole('button', { name: '-' }));
    await user.click(screen.getByRole('button', { name: '5' }));
    expect(screen.getByRole('button', { name: 'Enter' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Enter' }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('disables Enter and cannot commit a value above max', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<NumpadHarness onClose={onClose} min={0} max={100} />);

    await user.click(screen.getByRole('button', { name: '1' }));
    await user.click(screen.getByRole('button', { name: '0' }));
    await user.click(screen.getByRole('button', { name: '1' }));
    expect(screen.getByRole('button', { name: 'Enter' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Enter' }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('re-enables Enter once the value is corrected back into range', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<NumpadHarness onClose={onClose} min={0} max={100} />);

    await user.click(screen.getByRole('button', { name: '1' }));
    await user.click(screen.getByRole('button', { name: '0' }));
    await user.click(screen.getByRole('button', { name: '1' }));
    expect(screen.getByRole('button', { name: 'Enter' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('button', { name: 'Enter' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Enter' }));
    expect(onClose).toHaveBeenCalledWith('10');
  });

  it('commits freely when no range is configured', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<NumpadHarness onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: '9' }));
    await user.click(screen.getByRole('button', { name: '9' }));
    await user.click(screen.getByRole('button', { name: '9' }));
    expect(screen.getByRole('button', { name: 'Enter' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Enter' }));
    expect(onClose).toHaveBeenCalledWith('999');
  });
});
