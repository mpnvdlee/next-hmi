import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VirtualKeyboard } from './VirtualKeyboard';

// Modifier keys in DOM order; the keys carry no names, only icons.
const MODIFIERS = ['Backspace', 'Tab', 'Caps Lock', 'Enter', 'Shift left', 'Shift right', 'Clear'];

function key(name: string): HTMLElement {
  if (name === 'Space')
    return document.querySelector<HTMLElement>('.hmi-virtual-input__key--size-12')!;
  const i = MODIFIERS.indexOf(name);
  if (i >= 0) return document.querySelectorAll<HTMLElement>('.hmi-virtual-input__key--modifier')[i];
  return screen.getByText(name, { selector: '.hmi-virtual-input__key span' }).closest('button')!;
}

const preview = () => document.querySelector('.hmi-virtual-input__value--keyboard');

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

    await user.click(key('a'));
    await user.click(key('/'));

    expect(screen.getByLabelText('Harness value')).toHaveTextContent('a/');
    expect(preview()).toHaveTextContent('a/');
  });

  it('uses Shift once for capital letters and special characters', async () => {
    const user = userEvent.setup();
    render(<KeyboardHarness />);

    await user.click(key('Shift left'));
    expect(key('Shift left')).toHaveAttribute('aria-pressed', 'true');
    await user.click(key('A'));
    await user.click(key('Shift right'));
    await user.click(key('!'));
    await user.click(key('b'));

    expect(screen.getByLabelText('Harness value')).toHaveTextContent('A!b');
  });

  it('keeps Caps Lock active and combines it with Shift', async () => {
    const user = userEvent.setup();
    render(<KeyboardHarness />);

    await user.click(key('Caps Lock'));
    await user.click(key('A'));
    await user.click(key('B'));
    await user.click(key('Shift left'));
    await user.click(key('c'));
    await user.click(key('D'));

    expect(screen.getByLabelText('Harness value')).toHaveTextContent('ABcD');
  });

  it('supports Tab, Space, Backspace, Clear, and Enter', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<KeyboardHarness onClose={onClose} />);

    await user.click(key('a'));
    await user.click(key('Tab'));
    await user.click(key('Space'));
    await user.click(key('Backspace'));
    expect(screen.getByLabelText('Harness value')).toHaveTextContent('a');

    await user.click(key('Clear'));
    expect(screen.getByLabelText('Harness value')).toBeEmptyDOMElement();

    await user.click(key('Enter'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('masks the preview without changing the entered value', async () => {
    const user = userEvent.setup();
    render(<KeyboardHarness password />);

    await user.click(key('a'));
    await user.click(key('b'));

    expect(screen.getByLabelText('Harness value')).toHaveTextContent('ab');
    expect(preview()).toHaveTextContent('••');
    expect(preview()).not.toHaveTextContent('ab');
  });
});
