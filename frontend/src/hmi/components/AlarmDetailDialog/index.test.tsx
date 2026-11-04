import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { AlarmInstance } from '@shared/types/alarm';
import { useHmiStore } from '@hmi/store/hmiStore';
import { sendWsMessage } from '@hmi/hooks/useWebSocket';
import { resolvePending } from '@hmi/utils/actionDispatcher';
import styles from './index.module.css';
import AlarmDetailDialog from './index';

vi.mock('@hmi/hooks/useWebSocket', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@hmi/hooks/useWebSocket')>()),
  sendWsMessage: vi.fn(),
}));

/** Make the backend answer every alarm ack frame with `ok` (and `reason`). */
function answerAcks(ok: boolean, reason?: string) {
  vi.mocked(sendWsMessage).mockImplementation((msg) => {
    const frame = msg as { type: string; requestId?: string };
    if (frame.type.startsWith('alarm_ack')) {
      resolvePending(String(frame.requestId), reason ? { reason } : {}, ok);
    }
    return true;
  });
}

/** The alarm ack frames sent so far. */
function ackFrames() {
  return vi
    .mocked(sendWsMessage)
    .mock.calls.map(([msg]) => msg as Record<string, unknown>)
    .filter((m) => String(m.type).startsWith('alarm_ack'));
}

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
        <AlarmDetailDialog alarm={alarm} onClose={onClose} />
      </MemoryRouter>,
    ),
  };
}

describe('AlarmDetailDialog', () => {
  beforeEach(() => {
    vi.mocked(sendWsMessage).mockReset();
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
    answerAcks(true);
    const user = userEvent.setup();
    const { onClose } = renderDialog(mkAlarm());

    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));

    expect(ackFrames()).toEqual([
      expect.objectContaining({ type: 'alarm_ack', instanceId: 'inst-1' }),
    ]);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  // Closing on a refusal would look exactly like success, so the dialog stays
  // put and the toast says why.
  it('keeps the dialog open and surfaces the reason when the ack is refused', async () => {
    answerAcks(false, 'not_found');
    const user = userEvent.setup();
    const { onClose } = renderDialog(mkAlarm());

    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));

    await waitFor(() => expect(useHmiStore.getState().pendingToasts).toHaveLength(1));
    expect(useHmiStore.getState().pendingToasts[0].message).toMatch(/no longer active/);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes via the close button without acknowledging', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog(mkAlarm());

    await user.click(document.querySelector<HTMLElement>('.hmi-modal__close')!);

    expect(ackFrames()).toEqual([]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes via an overlay click but not a click inside the dialog card', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { baseElement } = renderDialog(mkAlarm(), onClose);

    await user.click(screen.getByText('Motor Overheat'));
    expect(onClose).not.toHaveBeenCalled();

    await user.click(baseElement.querySelector(`.${styles.overlay}`) as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // The backend resolves an alarm's image to an asset-relative path
  // (`AlarmDefinition.resolve_image`), and the URL has to carry the runtime
  // base — a project served under /runtime/<slug>/ 404s on a bare /assets/… .
  it('renders an image column when the alarm has an image', () => {
    const { baseElement } = renderDialog(mkAlarm({ image: 'images/motor.png' }));
    const img = baseElement.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('/assets/images/motor.png');
  });
});
