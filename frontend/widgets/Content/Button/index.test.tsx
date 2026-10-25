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
    useHmiStore.setState({ openPageOverlays: [], pendingToasts: [] });
  });

  afterEach(() => {
    __resetForTests();
  });

  it('renders its label', () => {
    renderButton({ label: 'Start Motor' });
    expect(screen.getByRole('button', { name: 'Start Motor' })).toBeInTheDocument();
  });

  it('emits the radius override as a custom property, not a literal style', () => {
    const { container } = renderButton({ label: 'Stop', radius: '2px' });
    const el = container.firstElementChild as HTMLElement;

    expect(el.style.getPropertyValue('--hmi-btn-radius')).toBe('2px');
  });

  it('leaves the radius override unset when no radius is configured', () => {
    const { container } = renderButton({ label: 'Stop' });
    const el = container.firstElementChild as HTMLElement;

    expect(el.style.getPropertyValue('--hmi-btn-radius')).toBe('');
  });

  it('writes true on click when bound to a variable', async () => {
    const user = userEvent.setup();
    renderButton({ label: 'Start', variable: { $var: { path: 'PLC:Motor/Cmd' } } });

    await user.click(screen.getByRole('button', { name: 'Start' }));

    expect(sendWsMessage).toHaveBeenCalledWith({
      type: 'write_field',
      requestId: expect.any(String),
      scope: 'runtime:preview',
      datasource: 'PLC',
      path: 'Motor/Cmd',
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

  it('hides the label but keeps it as the accessible name when Show label is off', () => {
    renderButton({ label: 'Reset', showLabel: false });

    const btn = screen.getByRole('button', { name: 'Reset' });
    expect(btn).toHaveAttribute('title', 'Reset');
    expect(btn.querySelector('.hmi-button__label')).toBeNull();
  });

  it('marks an icon-only button so it drops the text padding, and only then', () => {
    const { rerender } = renderButton({ label: 'Reset', showLabel: false });
    expect(screen.getByRole('button', { name: 'Reset' })).toHaveClass('hmi-button__btn--icon-only');

    rerender(
      <MemoryRouter>
        <Button properties={{ label: 'Reset' }} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Reset' })).not.toHaveClass(
      'hmi-button__btn--icon-only',
    );
  });

  it('omits an empty accessible name and title when the hidden label is empty', () => {
    renderButton({ label: '', showLabel: false });

    const btn = screen.getByRole('button');
    expect(btn).not.toHaveAttribute('aria-label');
    expect(btn).not.toHaveAttribute('title');
  });

  it('stacks the icon above the text with the top icon position', () => {
    renderButton({ label: 'Home', iconPosition: 'top' });

    expect(screen.getByRole('button', { name: 'Home' })).toHaveClass('hmi-button__btn--icon-top');
  });

  it('emits icon size, border width and outline fill as custom properties', () => {
    const { container } = renderButton({
      label: 'Jog',
      variant: 'outline',
      iconSize: 32,
      borderWidth: 3,
      fill: '#102030',
    });
    const el = container.firstElementChild as HTMLElement;

    expect(el.style.getPropertyValue('--hmi-btn-icon-size')).toBe('32px');
    expect(el.style.getPropertyValue('--hmi-btn-border-width')).toBe('3px');
    expect(el.style.getPropertyValue('--hmi-btn-fill')).toBe('#102030');
  });

  it('leaves the new overrides unset so the default look stays', () => {
    const { container } = renderButton({ label: 'Jog' });
    const el = container.firstElementChild as HTMLElement;

    for (const prop of ['--hmi-btn-icon-size', '--hmi-btn-border-width', '--hmi-btn-fill']) {
      expect(el.style.getPropertyValue(prop)).toBe('');
    }
    expect(screen.getByRole('button', { name: 'Jog' })).not.toHaveAttribute('title');
  });

  it('dispatches configured onPress actions', async () => {
    const user = userEvent.setup();
    renderButton({
      label: 'Open',
      actions: { onPress: [{ type: 'openPageOverlay', pageId: 'settings' }] },
    });

    await user.click(screen.getByRole('button', { name: 'Open' }));

    expect(useHmiStore.getState().openPageOverlays.map((o) => o.pageId)).toContain('settings');
  });
});
