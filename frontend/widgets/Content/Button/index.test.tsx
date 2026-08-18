import '../../testSdk';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { useVariableStore } from '@hmi/store/variableStore';
import { useHmiStore } from '@hmi/store/hmiStore';
import { sendWsMessage } from '@hmi/hooks/useWebSocket';
import { __resetForTests, resolvePending } from '@hmi/utils/actionDispatcher';
import Button from './index';

vi.mock('@hmi/hooks/useWebSocket', () => ({
  sendWsMessage: vi.fn(),
}));

function sentFrame(): Record<string, unknown> {
  return vi.mocked(sendWsMessage).mock.calls[0][0] as Record<string, unknown>;
}

function renderButton(properties: Record<string, unknown>) {
  return render(
    <MemoryRouter>
      <Button properties={properties} />
    </MemoryRouter>,
  );
}

describe('Button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetForTests();
    useVariableStore.setState({ values: {}, varMeta: {} });
    useHmiStore.setState({ openDialogs: [], openPageOverlays: [], pendingToasts: [] });
  });

  afterEach(() => {
    __resetForTests();
  });

  it('renders its label', () => {
    renderButton({ label: 'Start Motor' });
    expect(screen.getByRole('button', { name: 'Start Motor' })).toBeInTheDocument();
  });

  it('writes bValue on click when bound to a variable', async () => {
    const user = userEvent.setup();
    renderButton({ label: 'Start', variable: { $var: { path: 'PLC:Motor/Cmd' } } });

    await user.click(screen.getByRole('button', { name: 'Start' }));

    expect(sendWsMessage).toHaveBeenCalledWith({
      type: 'write_field',
      requestId: expect.any(String),
      scope: 'runtime:preview',
      datasource: 'PLC',
      path: 'Motor/Cmd',
      field: 'bValue',
      value: true,
    });
    expect(sentFrame().requestId).toBeTruthy();
  });

  it('toasts the rejection the backend correlates back to the write', async () => {
    const user = userEvent.setup();
    renderButton({ label: 'Start', variable: { $var: { path: 'PLC:Motor/Cmd' } } });

    await user.click(screen.getByRole('button', { name: 'Start' }));

    resolvePending(String(sentFrame().requestId), { reason: 'permission_denied' }, false);

    const toasts = useHmiStore.getState().pendingToasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].severity).toBe('error');
    expect(toasts[0].message).toMatch(/not allowed/i);
  });

  it('disables the button and ignores clicks when its bEnabled field is false', async () => {
    useVariableStore.setState({
      values: { 'PLC:Motor/Cmd': { bVisible: true, bEnabled: false } },
    });
    const user = userEvent.setup();
    renderButton({ label: 'Start', variable: { $var: { path: 'PLC:Motor/Cmd' } } });

    const btn = screen.getByRole('button', { name: 'Start' });
    expect(btn).toBeDisabled();

    await user.click(btn);

    expect(sendWsMessage).not.toHaveBeenCalled();
  });

  it('renders nothing when its bVisible field is false', () => {
    useVariableStore.setState({
      values: { 'PLC:Motor/Cmd': { bVisible: false } },
    });
    const { container } = renderButton({
      label: 'Start',
      variable: { $var: { path: 'PLC:Motor/Cmd' } },
    });

    expect(container.firstChild).toBeNull();
  });

  it('applies an outline style with a transparent background and colored border/text', () => {
    renderButton({ label: 'Calibrate', variant: 'outline', color: '#d0452f' });

    const btn = screen.getByRole('button', { name: 'Calibrate' });
    expect(btn.style.backgroundColor).toBe('');
    expect(btn.style.color).toBe('rgb(208, 69, 47)');
    expect(btn.style.borderColor).toBe('rgb(208, 69, 47)');
  });

  it('keeps the default solid fill when no variant is set', () => {
    renderButton({ label: 'Measure', color: '#22a7e0' });

    const btn = screen.getByRole('button', { name: 'Measure' });
    expect(btn.style.backgroundColor).toBe('rgb(34, 167, 224)');
  });

  it('dispatches configured onPress actions', async () => {
    const user = userEvent.setup();
    renderButton({
      label: 'Open',
      actions: { onPress: [{ type: 'openDialog', dialogId: 'settings' }] },
    });

    await user.click(screen.getByRole('button', { name: 'Open' }));

    expect(useHmiStore.getState().openDialogs.map((d) => d.id)).toContain('settings');
  });
});
