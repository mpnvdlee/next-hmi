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

async function press(user: ReturnType<typeof userEvent.setup>, ...keys: string[]) {
  for (const key of keys) await user.click(screen.getByRole('button', { name: key }));
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

  it('cancels on Escape', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    const onCancel = vi.fn();
    render(<NumpadHarness onApply={onApply} onCancel={onCancel} />);

    await press(user, '7');
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
    expect(screen.getByRole('button', { name: 'Enter' })).toBeDisabled();
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
    expect(screen.getByRole('button', { name: 'Enter' })).toBeDisabled();
  });

  it('starts empty with the current value as placeholder and a current-setpoint line', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<NumpadHarness onApply={onApply} currentValue="35" unit="ml" />);

    expect(screen.getByText('Current setpoint 35 ml')).toBeInTheDocument();
    await press(user, '7', 'Enter');
    expect(onApply).toHaveBeenCalledWith('7');
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
});
