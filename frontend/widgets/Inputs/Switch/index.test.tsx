import '../../testSdk';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { useVariableStore } from '@hmi/store/variableStore';
import { useHmiStore } from '@hmi/store/hmiStore';
import { sendWsMessage } from '@hmi/hooks/useWebSocket';
import { __resetForTests } from '@hmi/utils/actionDispatcher';
import Switch from './index';

vi.mock('@hmi/hooks/useWebSocket', () => ({
  sendWsMessage: vi.fn(),
}));

function sentFrame(): Record<string, unknown> {
  return vi.mocked(sendWsMessage).mock.calls[0][0] as Record<string, unknown>;
}

function renderSwitch(properties: Record<string, unknown>) {
  return render(
    <MemoryRouter>
      <Switch properties={properties} />
    </MemoryRouter>,
  );
}

describe('Switch', () => {
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
    const { container } = renderSwitch({});
    const el = container.firstElementChild as HTMLElement;

    expect(el.className).toContain('hmi-component');
    expect(el.className).toContain('hmi-switch');
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('switch')).toHaveAttribute('aria-busy', 'true');
  });

  it('renders its label and reflects the bound value', () => {
    useVariableStore.setState({ values: { 'PLC:Pump/Running': true } });
    renderSwitch({ label: 'Pump', variable: { $var: { path: 'PLC:Pump/Running' } } });

    expect(screen.getByText('Pump')).toBeInTheDocument();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch').className).toContain('hmi-switch__track--on');
  });

  it('shows an unknown state, and writes nothing, until the bound value arrives', async () => {
    const user = userEvent.setup();
    renderSwitch({ variable: { $var: { path: 'PLC:Pump/Running' } } });
    const track = screen.getByRole('switch');

    expect(track).toHaveAttribute('aria-checked', 'false');
    expect(track).toHaveAttribute('aria-busy', 'true');
    expect(track.className).toContain('hmi-switch__track--unknown');
    expect(track).toBeDisabled();
    await user.click(track);
    expect(sendWsMessage).not.toHaveBeenCalled();

    act(() => useVariableStore.getState().setScalar('PLC:Pump/Running', false));
    expect(track).toHaveAttribute('aria-checked', 'false');
    expect(track).not.toHaveAttribute('aria-busy');
    expect(track.className).not.toContain('hmi-switch__track--unknown');
    expect(track).toBeEnabled();
  });

  it('writes the inverted boolean with a correlating requestId', async () => {
    useVariableStore.setState({ values: { 'PLC:Pump/Running': false } });
    const user = userEvent.setup();
    renderSwitch({ variable: { $var: { path: 'PLC:Pump/Running' } } });

    await user.click(screen.getByRole('switch'));

    expect(sendWsMessage).toHaveBeenCalledWith({
      type: 'write_field',
      requestId: expect.any(String),
      scope: 'runtime:preview',
      datasource: 'PLC',
      path: 'Pump/Running',
      value: true,
    });
    expect(sentFrame().requestId).toBeTruthy();
  });

  it('writes false when the bound value is already on', async () => {
    useVariableStore.setState({ values: { 'PLC:Pump/Running': true } });
    const user = userEvent.setup();
    renderSwitch({ variable: { $var: { path: 'PLC:Pump/Running' } } });

    await user.click(screen.getByRole('switch'));

    expect(sentFrame().value).toBe(false);
  });

  it('sends nothing when the value property holds no binding', async () => {
    const user = userEvent.setup();
    renderSwitch({ variable: { $static: false } });

    await user.click(screen.getByRole('switch'));

    expect(sendWsMessage).not.toHaveBeenCalled();
  });

  it('disables the control when nothing at all drives it', () => {
    renderSwitch({ label: 'Pump' });

    expect(screen.getByRole('switch')).toBeDisabled();
  });

  // A non-$var source resolves to a value the writer cannot write back, so an
  // enabled switch would swallow the click and snap back on the next render.
  it('disables the control for a source that is not a $var binding', () => {
    renderSwitch({ variable: { $static: true } });

    expect(screen.getByRole('switch')).toBeDisabled();
  });
});
