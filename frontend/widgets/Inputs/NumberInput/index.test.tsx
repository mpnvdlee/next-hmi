import '../../testSdk';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { useVariableStore } from '@hmi/store/variableStore';
import { useHmiStore } from '@hmi/store/hmiStore';
import { sendWsMessage } from '@hmi/hooks/useWebSocket';
import { __resetForTests } from '@hmi/utils/actionDispatcher';
import NumberInput from './index';

vi.mock('@hmi/hooks/useWebSocket', () => ({
  sendWsMessage: vi.fn(),
}));

const VAR_KEY = 'PLC:Tank/Level';
const BINDING = { $var: { path: VAR_KEY } };

function sentFrame(): Record<string, unknown> {
  return vi.mocked(sendWsMessage).mock.calls[0][0] as Record<string, unknown>;
}

function renderInput(properties: Record<string, unknown>) {
  return render(
    <MemoryRouter>
      <NumberInput properties={properties} />
    </MemoryRouter>,
  );
}

/** Scalar meta — what the whole-variable write coerces against. */
function scalarMeta(range: { min?: number; max?: number }, base: 'Float' | 'Integer' = 'Float') {
  return {
    varMeta: {
      [VAR_KEY]: { type: { kind: 'scalar' as const, base, array: false }, ...range },
    },
  };
}

describe('NumberInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetForTests();
    useVariableStore.setState({ values: {}, varMeta: {} });
    useHmiStore.setState({ pendingToasts: [] });
  });

  afterEach(() => {
    __resetForTests();
  });

  it('renders with no properties at all', () => {
    const { container } = renderInput({});
    const el = container.firstElementChild as HTMLElement;

    expect(el.className).toContain('hmi-component');
    expect(el.className).toContain('hmi-number-input');
    expect(screen.getByRole('textbox')).toHaveValue('---');
  });

  it('writes the value with a correlating requestId when the operator commits', async () => {
    useVariableStore.setState({ values: { [VAR_KEY]: 12 } });
    const user = userEvent.setup();
    renderInput({ variable: BINDING });

    const field = screen.getByRole('textbox');
    await user.clear(field);
    await user.type(field, '42{Enter}');

    expect(sendWsMessage).toHaveBeenCalledWith({
      type: 'write_field',
      requestId: expect.any(String),
      scope: 'runtime:preview',
      datasource: 'PLC',
      path: 'Tank/Level',
      value: 42,
    });
    expect(sentFrame().requestId).toBeTruthy();
  });

  it('refuses a typed value outside the variable range and says why', async () => {
    useVariableStore.setState({
      values: { [VAR_KEY]: 12 },
      ...scalarMeta({ min: 0, max: 100 }),
    });
    const user = userEvent.setup();
    renderInput({ variable: BINDING });

    const field = screen.getByRole('textbox');
    await user.clear(field);
    await user.type(field, '500{Enter}');

    expect(sendWsMessage).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a value between 0 and 100');
  });

  it('refuses a numpad entry above the widget max instead of clamping it', async () => {
    useVariableStore.setState({ values: { [VAR_KEY]: 12 } });
    const user = userEvent.setup();
    // The range hint hidden: the bounds must hold all the same.
    renderInput({ variable: BINDING, min: 0, max: 100, showRangeOnNumpad: false });

    await user.click(screen.getByRole('textbox'));
    for (const digit of '5000') {
      await user.click(screen.getByRole('button', { name: digit }));
    }
    await user.click(screen.getByRole('button', { name: 'Enter' }));

    expect(sendWsMessage).not.toHaveBeenCalled();
  });

  it('writes nothing when the operator closes the numpad with ×', async () => {
    useVariableStore.setState({ values: { [VAR_KEY]: 12 } });
    const user = userEvent.setup();
    renderInput({ variable: BINDING });

    await user.click(screen.getByRole('textbox'));
    await user.click(screen.getByRole('button', { name: '7' }));
    await user.click(document.querySelector<HTMLElement>('.hmi-virtual-input__close')!);

    expect(sendWsMessage).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toHaveValue('12');
  });

  it('reopens the numpad on a second tap while the field still has focus', async () => {
    useVariableStore.setState({ values: { [VAR_KEY]: 12 } });
    const user = userEvent.setup();
    renderInput({ variable: BINDING });

    const field = screen.getByRole('textbox');
    await user.click(field);
    await user.click(document.querySelector<HTMLElement>('.hmi-virtual-input__close')!);
    expect(field).toHaveFocus();
    expect(document.querySelector('.hmi-virtual-input__key--accent')).not.toBeInTheDocument();

    await user.click(field);
    expect(
      document.querySelector<HTMLElement>('.hmi-virtual-input__key--accent')!,
    ).toBeInTheDocument();
  });

  it('starts the entry empty, so a key replaces the value instead of appending', async () => {
    useVariableStore.setState({ values: { [VAR_KEY]: 35 } });
    const user = userEvent.setup();
    renderInput({ variable: BINDING });

    await user.click(screen.getByRole('textbox'));
    expect(screen.getByText('Current setpoint 35')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '7' }));
    await user.click(document.querySelector<HTMLElement>('.hmi-virtual-input__key--accent')!);

    expect(sentFrame().value).toBe(7);
  });

  it('shows and limits the configured decimal places', async () => {
    useVariableStore.setState({ values: { [VAR_KEY]: 2 } });
    const user = userEvent.setup();
    renderInput({ variable: BINDING, decimals: 0 });

    expect(screen.getByRole('textbox')).toHaveValue('2');
    await user.click(screen.getByRole('textbox'));
    expect(screen.getByRole('button', { name: '.' })).toBeDisabled();
  });

  it('disables minus when negatives are not allowed', async () => {
    useVariableStore.setState({ values: { [VAR_KEY]: 2 } });
    const user = userEvent.setup();
    renderInput({ variable: BINDING, allowNegative: false });

    await user.click(screen.getByRole('textbox'));
    expect(screen.getByRole('button', { name: '-' })).toBeDisabled();
  });

  it('flags a value the variable range allows but the widget range does not', () => {
    useVariableStore.setState({
      values: { [VAR_KEY]: 50 },
      ...scalarMeta({ min: 0, max: 100 }),
    });
    const { container } = renderInput({ variable: BINDING, max: 10 });

    expect(container.querySelector('.hmi-number-input__field--invalid')).not.toBeNull();
  });

  it('falls back to the variable range when the widget sets none', () => {
    useVariableStore.setState({
      values: { [VAR_KEY]: 150 },
      ...scalarMeta({ min: 0, max: 100 }),
    });
    const { container } = renderInput({ variable: BINDING });

    expect(container.querySelector('.hmi-number-input__field--invalid')).not.toBeNull();
  });

  it('reads a value beyond 2**53, which arrives as its decimal string', () => {
    useVariableStore.setState({
      values: { [VAR_KEY]: '9007199254740993' },
      ...scalarMeta({ min: 0, max: 100 }),
    });
    const { container } = renderInput({ variable: BINDING });

    expect(screen.getByRole('textbox')).toHaveValue('9007199254740992');
    expect(container.querySelector('.hmi-number-input__field--invalid')).not.toBeNull();
  });

  it('disables the point for an Integer variable', async () => {
    useVariableStore.setState({ values: { [VAR_KEY]: 3 }, ...scalarMeta({}, 'Integer') });
    const user = userEvent.setup();
    renderInput({ variable: BINDING, decimals: 2 });

    await user.click(screen.getByRole('textbox'));
    expect(screen.getByRole('button', { name: '.' })).toBeDisabled();
  });

  // Only a $var binding reaches the writer, so any other source must not offer
  // an editable field: the commit would be swallowed without a word.
  it('disables the field for a source it cannot write back to', () => {
    renderInput({ variable: { $static: 3 } });

    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.getByRole('textbox')).toHaveValue('3');
  });
});
