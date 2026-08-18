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

/** Struct meta carrying only a per-field range — the shape the field write coerces against. */
function structMeta(fieldRanges: Record<string, { min?: number; max?: number }>) {
  return {
    varMeta: {
      [VAR_KEY]: {
        type: { kind: 'struct' as const, name: 'Setpoint', fields: ['fValue'], array: false },
        fieldRanges,
      },
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

  it('writes fValue with a correlating requestId when the operator commits', async () => {
    useVariableStore.setState({ values: { [VAR_KEY]: { fValue: 12 } } });
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
      field: 'fValue',
      value: 42,
    });
    expect(sentFrame().requestId).toBeTruthy();
  });

  it('sends nothing and toasts when the value is outside the field range', async () => {
    useVariableStore.setState({
      values: { [VAR_KEY]: { fValue: 12 } },
      ...structMeta({ fValue: { min: 0, max: 100 } }),
    });
    const user = userEvent.setup();
    renderInput({ variable: BINDING });

    const field = screen.getByRole('textbox');
    await user.clear(field);
    await user.type(field, '500{Enter}');

    expect(sendWsMessage).not.toHaveBeenCalled();
    const toasts = useHmiStore.getState().pendingToasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toMatch(/outside the allowed range/i);
  });

  it('clamps a numpad commit to the widget max', async () => {
    useVariableStore.setState({ values: { [VAR_KEY]: { fValue: 12 } } });
    const user = userEvent.setup();
    // showRangeOnNumpad off so the numpad itself does not gate Enter — the
    // widget's own clamp is what has to hold the limit here.
    renderInput({ variable: BINDING, min: 0, max: 100, showRangeOnNumpad: false });

    await user.click(screen.getByRole('textbox'));
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    for (const digit of '5000') {
      await user.click(screen.getByRole('button', { name: digit }));
    }
    await user.click(screen.getByRole('button', { name: 'Enter' }));

    expect(sentFrame().value).toBe(100);
  });

  it('flags a value the variable range allows but the widget range does not', () => {
    useVariableStore.setState({
      values: { [VAR_KEY]: { fValue: 50 } },
      ...structMeta({ fValue: { min: 0, max: 100 } }),
    });
    const { container } = renderInput({ variable: BINDING, max: 10 });

    expect(container.querySelector('.hmi-number-input__field--invalid')).not.toBeNull();
  });

  it('falls back to the variable range when the widget sets none', () => {
    useVariableStore.setState({
      values: { [VAR_KEY]: { fValue: 150 } },
      ...structMeta({ fValue: { min: 0, max: 100 } }),
    });
    const { container } = renderInput({ variable: BINDING });

    expect(container.querySelector('.hmi-number-input__field--invalid')).not.toBeNull();
  });

  it('renders nothing when its bVisible field is false', () => {
    useVariableStore.setState({ values: { [VAR_KEY]: { bVisible: false } } });
    const { container } = renderInput({ variable: BINDING });

    expect(container.firstChild).toBeNull();
  });

  // Only a $var binding reaches the writer, so any other source must not offer
  // an editable field: the commit would be swallowed without a word.
  it('disables the field for a struct source it cannot write back to', () => {
    renderInput({ variable: { $static: { bEnabled: true, fValue: 3 } } });

    expect(screen.getByRole('textbox')).toBeDisabled();
  });

  it('disables the field when its bEnabled field is false', () => {
    useVariableStore.setState({ values: { [VAR_KEY]: { bEnabled: false, fValue: 3 } } });
    renderInput({ variable: BINDING });

    expect(screen.getByRole('textbox')).toBeDisabled();
  });
});
