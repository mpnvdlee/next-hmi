import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { AlarmInstance } from '@shared/types/alarm';
import { useHmiStore } from '@hmi/store/hmiStore';
import { apiJson } from '@shared/utils/api';
import styles from './index.module.css';
import AlarmDetailDialog from './index';

vi.mock('@shared/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/utils/api')>()),
  apiJson: vi.fn(),
}));

function mkAlarm(overrides: Partial<AlarmInstance> = {}): AlarmInstance {
  return {
    id: 'inst-1',
    alarm_id: 'def-1',
    code: 'A-001',
    level: 'error',
    title: 'Motor Overheat',
    description: 'Motor exceeded safe temperature.',
    image: '',
    resolutions: [],
    group_title: 'Motors',
    auto_popup: true,
    ack_groups: [],
    triggered_at: '2026-01-01T10:00:00Z',
    acked: false,
    acked_by: '',
    acked_at: '',
    ...overrides,
  };
}

function renderDialog(alarm: AlarmInstance, onClose = vi.fn()) {
  return {
    onClose,
    ...render(
      <MemoryRouter>
        <AlarmDetailDialog alarm={alarm} username="operator" onClose={onClose} />
      </MemoryRouter>,
    ),
  };
}

describe('AlarmDetailDialog', () => {
  beforeEach(() => {
    vi.mocked(apiJson).mockReset();
    useHmiStore.setState({ pendingToasts: [] });
  });

  it('renders title, code, description, and level badge', () => {
    renderDialog(mkAlarm());

    expect(screen.getByText('Motor Overheat')).toBeInTheDocument();
    expect(screen.getByText('A-001')).toBeInTheDocument();
    expect(screen.getByText('Motor exceeded safe temperature.')).toBeInTheDocument();
    const badge = screen.getByText('error');
    expect(badge.className).toContain(styles.levelError);
  });

  it('applies the warning level styling variant', () => {
    renderDialog(mkAlarm({ level: 'warning' }));
    const badge = screen.getByText('warning');
    expect(badge.className).toContain(styles.levelWarning);
  });

  it('applies the info level styling variant', () => {
    renderDialog(mkAlarm({ level: 'info' }));
    const badge = screen.getByText('info');
    expect(badge.className).toContain(styles.levelInfo);
  });

  it('renders resolutions when present', () => {
    renderDialog(mkAlarm({ resolutions: ['Check the coolant loop', 'Restart the drive'] }));

    expect(screen.getByText('– Check the coolant loop')).toBeInTheDocument();
    expect(screen.getByText('– Restart the drive')).toBeInTheDocument();
  });

  it('omits the resolutions section when there are none', () => {
    renderDialog(mkAlarm({ resolutions: [] }));
    expect(screen.queryByText('Resolutions')).not.toBeInTheDocument();
  });

  it('shows acknowledged metadata for an acked alarm and hides the Acknowledge button', () => {
    renderDialog(mkAlarm({ acked: true, acked_by: 'jdoe', acked_at: '2026-01-01T10:05:00Z' }));

    expect(screen.getByText(/Acknowledged by: jdoe/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument();
  });

  it('acknowledges the alarm and closes on Acknowledge click', async () => {
    vi.mocked(apiJson).mockResolvedValue(undefined);
    const user = userEvent.setup();
    const { onClose } = renderDialog(mkAlarm());

    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));

    expect(apiJson).toHaveBeenCalledWith(
      '/api/alarms/ack/inst-1',
      expect.objectContaining({ method: 'POST', body: { username: 'operator' } }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // Closing on a refusal would look exactly like success, so the dialog stays
  // put and the toast says why.
  it('keeps the dialog open and surfaces the reason when the ack is refused', async () => {
    vi.mocked(apiJson).mockRejectedValue(new Error('You are not allowed to acknowledge'));
    const user = userEvent.setup();
    const { onClose } = renderDialog(mkAlarm());

    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));

    await waitFor(() => expect(useHmiStore.getState().pendingToasts).toHaveLength(1));
    expect(useHmiStore.getState().pendingToasts[0].message).toMatch(/not allowed to acknowledge/);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes via the close button without acknowledging', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog(mkAlarm());

    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(apiJson).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes via an overlay click but not a click inside the dialog card', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { container } = renderDialog(mkAlarm(), onClose);

    await user.click(screen.getByText('Motor Overheat'));
    expect(onClose).not.toHaveBeenCalled();

    await user.click(container.querySelector(`.${styles.overlay}`) as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // The backend resolves an alarm's image to an asset-relative path
  // (`AlarmDefinition.resolve_image`), and the URL has to carry the runtime
  // base — a project served under /runtime/<slug>/ 404s on a bare /assets/… .
  it('renders an image column when the alarm has an image', () => {
    const { container } = renderDialog(mkAlarm({ image: 'images/motor.png' }));
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('/assets/images/motor.png');
  });
});
