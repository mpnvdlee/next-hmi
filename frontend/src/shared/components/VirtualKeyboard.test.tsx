import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VirtualKeyboard } from './VirtualKeyboard';

function KeyboardHarness({
  onClose = () => undefined,
  password = false,
}: {
  onClose?: () => void;
  password?: boolean;
}) {
  const [value, setValue] = useState('');
  return (
    <>
      <output aria-label="Harness value">{value}</output>
      <VirtualKeyboard
        isOpen
        value={value}
        onChange={setValue}
        onClose={onClose}
        password={password}
      />
    </>
  );
}

describe('VirtualKeyboard', () => {
  it('types lowercase letters and the base punctuation characters', async () => {
    const user = userEvent.setup();
    render(<KeyboardHarness />);

    await user.click(screen.getByRole('button', { name: 'a' }));
    await user.click(screen.getByRole('button', { name: '/' }));

    expect(screen.getByLabelText('Harness value')).toHaveTextContent('a/');
    expect(screen.getByLabelText('Keyboard value')).toHaveTextContent('a/');
  });

  it('uses Shift once for capital letters and special characters', async () => {
    const user = userEvent.setup();
    render(<KeyboardHarness />);

    await user.click(screen.getByRole('button', { name: 'Shift left' }));
    expect(screen.getByRole('button', { name: 'Shift left' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(screen.getByRole('button', { name: 'A' }));
    await user.click(screen.getByRole('button', { name: 'Shift right' }));
    await user.click(screen.getByRole('button', { name: '!' }));
    await user.click(screen.getByRole('button', { name: 'b' }));

    expect(screen.getByLabelText('Harness value')).toHaveTextContent('A!b');
  });

  it('keeps Caps Lock active and combines it with Shift', async () => {
    const user = userEvent.setup();
    render(<KeyboardHarness />);

    await user.click(screen.getByRole('button', { name: 'Caps Lock' }));
    await user.click(screen.getByRole('button', { name: 'A' }));
    await user.click(screen.getByRole('button', { name: 'B' }));
    await user.click(screen.getByRole('button', { name: 'Shift left' }));
    await user.click(screen.getByRole('button', { name: 'c' }));
    await user.click(screen.getByRole('button', { name: 'D' }));

    expect(screen.getByLabelText('Harness value')).toHaveTextContent('ABcD');
  });

  it('supports Tab, Space, Backspace, Clear, and Enter', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<KeyboardHarness onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: 'a' }));
    await user.click(screen.getByRole('button', { name: 'Tab' }));
    await user.click(screen.getByRole('button', { name: 'Space' }));
    await user.click(screen.getByRole('button', { name: 'Backspace' }));
    expect(screen.getByLabelText('Harness value')).toHaveTextContent('a');

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByLabelText('Harness value')).toBeEmptyDOMElement();

    await user.click(screen.getByRole('button', { name: 'Enter' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('masks the preview without changing the entered value', async () => {
    const user = userEvent.setup();
    render(<KeyboardHarness password />);

    await user.click(screen.getByRole('button', { name: 'a' }));
    await user.click(screen.getByRole('button', { name: 'b' }));

    expect(screen.getByLabelText('Harness value')).toHaveTextContent('ab');
    expect(screen.getByLabelText('Password value, 2 characters')).toHaveTextContent('••');
    expect(screen.getByLabelText('Password value, 2 characters')).not.toHaveTextContent('ab');
  });
});
