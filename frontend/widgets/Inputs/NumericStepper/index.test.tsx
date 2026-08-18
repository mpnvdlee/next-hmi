import '../../testSdk';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { useVariableStore } from '@hmi/store/variableStore';
import { useHmiStore } from '@hmi/store/hmiStore';
import { sendWsMessage } from '@hmi/hooks/useWebSocket';
import { __resetForTests, resolvePending } from '@hmi/utils/actionDispatcher';
import NumericStepper from './index';

vi.mock('@hmi/hooks/useWebSocket', () => ({
  sendWsMessage: vi.fn(),
}));

const VAR_KEY = 'PLC:Motor/Speed';
const BINDING = { $var: { path: VAR_KEY } };

function frames(): Record<string, unknown>[] {
  return vi.mocked(sendWsMessage).mock.calls.map((c) => c[0] as Record<string, unknown>);
}

function renderStepper(properties: Record<string, unknown>) {
  return render(
    <MemoryRouter>
      <NumericStepper properties={properties} />
    </MemoryRouter>,
  );
}

/** Scalar meta — what the whole-variable write coerces against. */
function scalarMeta(range: { min?: number; max?: number }) {
  return {
    varMeta: {
      [VAR_KEY]: {
        type: { kind: 'scalar' as const, base: 'Float' as const, array: false },
        ...range,
      },
    },
  };
}

describe('NumericStepper', () => {
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
    const { container } = renderStepper({});
    const el = container.firstElementChild as HTMLElement;

    expect(el.className).toContain('hmi-component');
    expect(el.className).toContain('hmi-numeric-stepper');
    expect(screen.getByText('---')).toBeInTheDocument();
  });

  it('writes the incremented value with a correlating requestId', async () => {
    useVariableStore.setState({ values: { [VAR_KEY]: 10 } });
    const user = userEvent.setup();
    renderStepper({ variable: BINDING, step: 5 });

    await user.click(screen.getByRole('button', { name: 'Increment' }));

    expect(sendWsMessage).toHaveBeenCalledWith({
      type: 'write_field',
      requestId: expect.any(String),
      scope: 'runtime:preview',
      datasource: 'PLC',
      path: 'Motor/Speed',
      value: 15,
    });
    expect(frames()[0].requestId).toBeTruthy();
  });

  it('writes the decremented value', async () => {
    useVariableStore.setState({ values: { [VAR_KEY]: 10 } });
    const user = userEvent.setup();
    renderStepper({ variable: BINDING, step: 2 });

    await user.click(screen.getByRole('button', { name: 'Decrement' }));

    expect(frames()[0].value).toBe(8);
  });

  it('clamps the reachable range with the step buttons', () => {
    useVariableStore.setState({ values: { [VAR_KEY]: 100 } });
    renderStepper({ variable: BINDING, step: 1, min: 0, max: 100 });

    expect(screen.getByRole('button', { name: 'Increment' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Decrement' })).toBeEnabled();
  });

  it('lets a widget range override the variable range', () => {
    useVariableStore.setState({
      values: { [VAR_KEY]: 50 },
      ...scalarMeta({ min: 0, max: 1000 }),
    });
    renderStepper({ variable: BINDING, step: 1, max: 50 });

    // 50 is well inside the variable's own 0..1000, so only the widget's
    // max: 50 can be what stops the increment.
    expect(screen.getByRole('button', { name: 'Increment' })).toBeDisabled();
  });

  it('clamps a numpad commit to the widget max', async () => {
    useVariableStore.setState({ values: { [VAR_KEY]: 10 } });
    const user = userEvent.setup();
    // showRangeOnNumpad off so the numpad itself does not gate Enter — the
    // widget's own clamp is what has to hold the limit here.
    renderStepper({ variable: BINDING, min: 0, max: 100, showRangeOnNumpad: false });

    await user.click(screen.getByRole('button', { name: 'Edit value' }));
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    for (const digit of '5000') {
      await user.click(screen.getByRole('button', { name: digit }));
    }
    await user.click(screen.getByRole('button', { name: 'Enter' }));

    expect(frames()[0].value).toBe(100);
  });

  it('marks the value invalid when it sits outside the widget range', () => {
    useVariableStore.setState({ values: { [VAR_KEY]: 120 } });
    const { container } = renderStepper({ variable: BINDING, min: 0, max: 100 });

    expect(container.querySelector('.hmi-numeric-stepper__value--invalid')).not.toBeNull();
  });

  it('shows one toast, not one per press, when repeated writes are rejected', async () => {
    useVariableStore.setState({ values: { [VAR_KEY]: 10 } });
    const user = userEvent.setup();
    renderStepper({ variable: BINDING, step: 1 });

    const increment = screen.getByRole('button', { name: 'Increment' });
    await user.click(increment);
    await user.click(increment);
    await user.click(increment);

    expect(frames()).toHaveLength(3);
    for (const frame of frames()) {
      resolvePending(String(frame.requestId), { reason: 'permission_denied' }, false);
    }

    const toasts = useHmiStore.getState().pendingToasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].severity).toBe('error');
  });

  // A non-$var source resolves to a value the writer cannot write back, so the
  // controls have to read as disabled instead of swallowing the press.
  it('disables the controls when the value property holds no binding', async () => {
    const user = userEvent.setup();
    renderStepper({ variable: { $static: 10 }, step: 1 });

    expect(screen.getByRole('button', { name: 'Increment' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Edit value' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Increment' }));

    expect(sendWsMessage).not.toHaveBeenCalled();
  });

  it('clamps a decimals value a binding pushed outside the schema range', () => {
    const low = renderStepper({ variable: { $static: 12.3456 }, decimals: -1 });
    expect(low.container.querySelector('.hmi-numeric-stepper__value')?.textContent).toBe('12');

    const high = renderStepper({ variable: { $static: 12.3456 }, decimals: 200 });
    expect(high.container.querySelector('.hmi-numeric-stepper__value')?.textContent).toBe(
      '12.345600',
    );
  });
});
