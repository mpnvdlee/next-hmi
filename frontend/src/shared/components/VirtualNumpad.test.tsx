import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VirtualNumpad } from './VirtualNumpad';

function NumpadHarness({
  onApply = () => undefined,
  onCancel = () => undefined,
  ...rest
}: {
  onApply?: (value: string) => void;
  onCancel?: () => void;
  min?: number;
  max?: number;
  unit?: string;
  currentValue?: string;
  decimals?: number;
  allowNegative?: boolean;
  showRange?: boolean;
  dockPosition?: 'center' | 'bottom-right';
}) {
  const [value, setValue] = useState('');
  return (
    <>
      <output aria-label="Harness value">{value}</output>
      <VirtualNumpad
        isOpen
        value={value}
        onChange={setValue}
        onApply={onApply}
        onCancel={onCancel}
        {...rest}
      />
    </>
  );
}

const field = () => document.querySelector<HTMLElement>('.hmi-virtual-input__field')!;

// The icon keys carry no names; the digit keys are named by their text.
const ICON_KEYS: Record<string, string> = {
  Back: '.hmi-virtual-input__key--back',
  Clear: '.hmi-virtual-input__key--clear',
  Enter: '.hmi-virtual-input__key--accent',
  'Close numpad': '.hmi-virtual-input__close',
};
const keyFor = (key: string) =>
  key in ICON_KEYS
    ? document.querySelector<HTMLElement>(ICON_KEYS[key])!
    : screen.getByRole('button', { name: key });

async function press(user: ReturnType<typeof userEvent.setup>, ...keys: string[]) {
  for (const key of keys) await user.click(keyFor(key));
}

describe('VirtualNumpad', () => {
  it('types digits and applies on Enter', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<NumpadHarness onApply={onApply} />);

    await press(user, '4', '2', 'Enter');

    expect(screen.getByLabelText('Harness value')).toHaveTextContent('42');
    expect(onApply).toHaveBeenCalledWith('42');
  });

  it('cancels on ×, without applying what was typed', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    const onCancel = vi.fn();
    render(<NumpadHarness onApply={onApply} onCancel={onCancel} />);

    await press(user, '7', 'Close numpad');

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('cancels on a press outside the panel', async () => {
    const onApply = vi.fn();
    const onCancel = vi.fn();
    render(<NumpadHarness onApply={onApply} onCancel={onCancel} />);

    fireEvent.mouseDown(document.body);

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('cancels on Escape, once, typed in the field', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    const onCancel = vi.fn();
    render(<NumpadHarness onApply={onApply} onCancel={onCancel} />);

    await press(user, '7');
    expect(field()).toHaveFocus();
    await user.keyboard('{Escape}');

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('refuses a value above max and says why, instead of clamping', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<NumpadHarness onApply={onApply} min={80} max={200} unit="ms" />);

    await press(user, '5', '0', '0', '0');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a value between 80 and 200 ms');
    expect(screen.getByRole('button', { name: 'Enter' })).toBeDisabled();

    await press(user, 'Enter');
    expect(onApply).not.toHaveBeenCalled();
  });

  it('names the one bound there is', async () => {
    const user = userEvent.setup();
    render(<NumpadHarness max={10} />);
    await press(user, '1', '1');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a value of at most 10');
  });

  it('still refuses out-of-range values when the range hint is hidden', async () => {
    const user = userEvent.setup();
    render(<NumpadHarness min={0} max={100} showRange={false} />);
    expect(screen.queryByText(/Min:/)).not.toBeInTheDocument();
    await press(user, '1', '0', '1');
    expect(document.querySelector<HTMLElement>('.hmi-virtual-input__key--accent')!).toBeDisabled();
  });

  it('re-enables Enter once the value is corrected back into range', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<NumpadHarness onApply={onApply} min={0} max={100} />);

    await press(user, '1', '0', '1');
    expect(screen.getByRole('button', { name: 'Enter' })).toBeDisabled();

    await press(user, 'Back');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await press(user, 'Enter');
    expect(onApply).toHaveBeenCalledWith('10');
  });

  it('cannot apply an empty entry', () => {
    render(<NumpadHarness />);
    expect(document.querySelector<HTMLElement>('.hmi-virtual-input__key--accent')!).toBeDisabled();
  });

  it('starts empty with the current value as placeholder, and no current-setpoint line', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<NumpadHarness onApply={onApply} currentValue="35" unit="ml" />);

    expect(field()).toHaveValue('');
    expect(field()).toHaveAttribute('placeholder', '35');
    expect(screen.queryByText(/Current setpoint/)).not.toBeInTheDocument();
    await press(user, '7', 'Enter');
    expect(onApply).toHaveBeenCalledWith('7');
  });

  it('opens with the focus in a field that keeps the tablet keyboard shut', async () => {
    const user = userEvent.setup();
    render(<NumpadHarness />);

    expect(field()).toHaveFocus();
    expect(field()).toHaveAttribute('inputmode', 'none');
    await press(user, '1', 'Back', '2');
    expect(field()).toHaveFocus();
  });

  it('takes physical typing through the same rules as the keys', async () => {
    const user = userEvent.setup();
    render(<NumpadHarness decimals={2} allowNegative={false} />);

    await user.keyboard('-1a2..345');
    expect(field()).toHaveValue('12.34');
    await user.keyboard('{Backspace}');
    expect(field()).toHaveValue('12.3');
  });

  it('toggles the sign on a typed minus, when negatives are allowed', async () => {
    const user = userEvent.setup();
    render(<NumpadHarness />);
    await user.keyboard('5-');
    expect(field()).toHaveValue('-5');
  });

  it('applies on a typed Enter only when the value is valid', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<NumpadHarness onApply={onApply} max={10} />);

    await user.keyboard('{Enter}11{Enter}');
    expect(onApply).not.toHaveBeenCalled();
    await user.keyboard('{Backspace}{Enter}');
    expect(onApply).toHaveBeenCalledWith('1');
  });

  it('accepts a paste only when the pasted text follows the rules', async () => {
    const user = userEvent.setup();
    render(<NumpadHarness decimals={1} />);

    await user.paste('1.25');
    expect(field()).toHaveValue('');
    await user.paste('abc');
    expect(field()).toHaveValue('');
    await user.paste('-1.5');
    expect(field()).toHaveValue('-1.5');
  });

  it('disables the point when decimals is 0', () => {
    render(<NumpadHarness decimals={0} />);
    expect(screen.getByRole('button', { name: '.' })).toBeDisabled();
  });

  it('stops taking digits after the point at the decimals limit', async () => {
    const user = userEvent.setup();
    render(<NumpadHarness decimals={1} />);
    await press(user, '2', '.', '5', '5');
    expect(screen.getByLabelText('Harness value')).toHaveTextContent('2.5');
  });

  it('disables minus when min is zero or more', () => {
    render(<NumpadHarness min={0} />);
    expect(screen.getByRole('button', { name: '-' })).toBeDisabled();
  });

  it('disables minus when negatives are not allowed', () => {
    render(<NumpadHarness allowNegative={false} />);
    expect(screen.getByRole('button', { name: '-' })).toBeDisabled();
  });

  it('applies freely when no range is configured', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<NumpadHarness onApply={onApply} />);

    await press(user, '-', '9', '9', '9', 'Enter');
    expect(onApply).toHaveBeenCalledWith('-999');
  });

  it('puts every key in one grid, with the hooks the 4-column theme layout places', () => {
    render(<NumpadHarness />);
    const grid = document.querySelector('.hmi-virtual-input__keys');

    expect(grid?.querySelectorAll('button')).toHaveLength(15);
    expect(document.querySelector<HTMLElement>('.hmi-virtual-input__key--back')!).toHaveClass(
      'hmi-virtual-input__key--back',
    );
    expect(document.querySelector<HTMLElement>('.hmi-virtual-input__key--clear')!).toHaveClass(
      'hmi-virtual-input__key--clear',
    );
    expect(document.querySelector<HTMLElement>('.hmi-virtual-input__key--accent')!).toHaveClass(
      'hmi-virtual-input__key--accent',
    );
  });

  it('scopes the numpad column rules to the numpad grid, not the text keyboard', async () => {
    // jsdom gives import.meta.url no file scheme; vitest runs from frontend/.
    const { readFileSync } = await import('node:fs');
    const hmiCss = readFileSync('src/hmi/styles/hmi.css', 'utf8');
    const rules = [...hmiCss.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, selector]) =>
      selector.includes('numpad-columns'),
    );

    expect(rules.length).toBe(3);
    for (const [, selector] of rules) expect(selector).toContain('.hmi-virtual-input__keys');
  });

  it("docks a centred numpad in the middle of the screen, not at the keyboard's bottom dock", async () => {
    render(<NumpadHarness dockPosition="center" />);
    const dock = document
      .querySelector<HTMLElement>('.hmi-virtual-input__key--accent')!
      .closest('.hmi-virtual-input__dock');
    expect(dock).toHaveClass('hmi-virtual-input__dock--middle');
    expect(dock).not.toHaveClass('hmi-virtual-input__dock--center');

    // jsdom lays nothing out, so read the rule; vitest runs from frontend/.
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('src/hmi/styles/hmi.css', 'utf8');
    const rule = /\.hmi-virtual-input__dock--middle \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('top: 50%');
    expect(rule).toContain('translate(-50%, -50%)');
  });
});
