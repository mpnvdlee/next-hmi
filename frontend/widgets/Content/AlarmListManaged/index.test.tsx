import '../../testSdk';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { AlarmInstance, AlarmSummary } from '@shared/types/alarm';
import { useAlarmStore } from '@hmi/store/alarmStore';
import { useHmiStore } from '@hmi/store/hmiStore';
import { apiJson } from '@shared/utils/api';
import AlarmListManaged from './index';

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
    description: '',
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

function mkSummary(overrides: Partial<AlarmSummary> = {}): AlarmSummary {
  return { total: 0, unacked: 0, error_count: 0, warning_count: 0, info_count: 0, ...overrides };
}

function renderList(properties: Record<string, unknown> = {}) {
  return render(
    <MemoryRouter>
      <AlarmListManaged properties={properties} />
    </MemoryRouter>,
  );
}

describe('AlarmListManaged', () => {
  beforeEach(() => {
    vi.mocked(apiJson).mockReset();
    useAlarmStore.setState({ active: [], summary: mkSummary() });
    useHmiStore.setState({ currentUsersByScope: {}, pendingToasts: [] });
  });

  it('shows an empty state when there are no active alarms', () => {
    renderList();
    expect(screen.getByText('No active alarms')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Acknowledge All' })).not.toBeInTheDocument();
  });

  it('renders live alarm rows with code, title, and unacked badge count', () => {
    useAlarmStore.setState({
      active: [mkAlarm(), mkAlarm({ id: 'inst-2', code: 'A-002', title: 'Pump Fault' })],
      summary: mkSummary({ total: 2, unacked: 2 }),
    });
    renderList();

    expect(screen.getByText('[A-001] Motor Overheat')).toBeInTheDocument();
    expect(screen.getByText('[A-002] Pump Fault')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('omits the code brackets for an alarm without a code', () => {
    useAlarmStore.setState({
      active: [mkAlarm({ code: '' })],
      summary: mkSummary({ total: 1, unacked: 1 }),
    });
    renderList();

    expect(screen.getByText('Motor Overheat')).toBeInTheDocument();
  });

  it('applies the badgeZero styling variant when the unacked count is 0', () => {
    useAlarmStore.setState({ active: [], summary: mkSummary({ total: 0, unacked: 0 }) });
    renderList();
    const badge = screen.getByText('0');
    expect(badge.className).toContain('hmi-alarm-list__badge--zero');
  });

  it('applies level-tinted row classes for error vs warning alarms', () => {
    useAlarmStore.setState({
      active: [
        mkAlarm({ level: 'error' }),
        mkAlarm({ id: 'inst-2', level: 'warning', code: 'A-002', title: 'Pump Warning' }),
      ],
      summary: mkSummary({ total: 2, unacked: 2 }),
    });
    const { container } = renderList();
    const rows = container.querySelectorAll('.hmi-alarm-list__row');
    expect(rows[0].className).not.toContain('hmi-alarm-list__row--acked');
  });

  it('filters rows by filterLevel', () => {
    useAlarmStore.setState({
      active: [
        mkAlarm({ level: 'error' }),
        mkAlarm({ id: 'inst-2', level: 'warning', code: 'A-002', title: 'Pump Warning' }),
      ],
      summary: mkSummary({ total: 2, unacked: 2 }),
    });
    renderList({ filterLevel: 'warning' });

    expect(screen.getByText('[A-002] Pump Warning')).toBeInTheDocument();
    expect(screen.queryByText('[A-001] Motor Overheat')).not.toBeInTheDocument();
  });

  // The badge used to switch meaning with the filter — unacked with no filter,
  // every matching row with one — so narrowing the level read as a jump in load.
  it('counts unacknowledged alarms within the filter, not every filtered row', () => {
    useAlarmStore.setState({
      active: [
        mkAlarm({ level: 'error' }),
        mkAlarm({ id: 'inst-2', code: 'A-002', level: 'error', acked: true }),
        mkAlarm({ id: 'inst-3', code: 'A-003', level: 'warning' }),
      ],
      summary: mkSummary({ total: 3, unacked: 2 }),
    });
    const { container } = renderList({ filterLevel: 'error' });

    expect(container.querySelector('.hmi-alarm-list__badge')?.textContent).toBe('1');
  });

  it('acknowledges a single alarm without opening its detail dialog', async () => {
    vi.mocked(apiJson).mockResolvedValue(undefined);
    const user = userEvent.setup();
    useAlarmStore.setState({ active: [mkAlarm()], summary: mkSummary({ total: 1, unacked: 1 }) });
    renderList();

    await user.click(screen.getByRole('button', { name: 'ACK' }));

    expect(apiJson).toHaveBeenCalledWith(
      '/api/alarms/ack/inst-1',
      expect.objectContaining({ method: 'POST', body: { username: 'operator' } }),
    );
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument();
  });

  it('acknowledges all alarms via the footer button', async () => {
    vi.mocked(apiJson).mockResolvedValue(undefined);
    const user = userEvent.setup();
    useAlarmStore.setState({
      active: [mkAlarm(), mkAlarm({ id: 'inst-2', code: 'A-002' })],
      summary: mkSummary({ total: 2, unacked: 2 }),
    });
    renderList();

    await user.click(screen.getByRole('button', { name: 'Acknowledge All' }));

    expect(apiJson).toHaveBeenCalledWith(
      '/api/alarms/ack-all',
      expect.objectContaining({ method: 'POST', body: { username: 'operator' } }),
    );
  });

  // A refused ack used to reject into nothing: the row stayed unacknowledged
  // and the operator was told nothing at all.
  it('toasts a refused ack instead of dropping it', async () => {
    vi.mocked(apiJson).mockRejectedValue(new Error('Active alarm not found'));
    const user = userEvent.setup();
    useAlarmStore.setState({ active: [mkAlarm()], summary: mkSummary({ total: 1, unacked: 1 }) });
    renderList();

    await user.click(screen.getByRole('button', { name: 'ACK' }));

    await waitFor(() => expect(useHmiStore.getState().pendingToasts).toHaveLength(1));
    const [toast] = useHmiStore.getState().pendingToasts;
    expect(toast.severity).toBe('error');
    expect(toast.message).toMatch(/Active alarm not found/);
  });

  it('toasts a refused acknowledge-all instead of dropping it', async () => {
    vi.mocked(apiJson).mockRejectedValue(new Error('Server unreachable'));
    const user = userEvent.setup();
    useAlarmStore.setState({ active: [mkAlarm()], summary: mkSummary({ total: 1, unacked: 1 }) });
    renderList();

    await user.click(screen.getByRole('button', { name: 'Acknowledge All' }));

    await waitFor(() => expect(useHmiStore.getState().pendingToasts).toHaveLength(1));
    expect(useHmiStore.getState().pendingToasts[0].message).toMatch(/Server unreachable/);
  });

  it('opens the detail dialog on row click and closes it', async () => {
    const user = userEvent.setup();
    useAlarmStore.setState({ active: [mkAlarm()], summary: mkSummary({ total: 1, unacked: 1 }) });
    renderList();

    await user.click(screen.getByText('[A-001] Motor Overheat'));
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeInTheDocument();

    await user.click(document.querySelector<HTMLElement>('.hmi-modal__close')!);
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument();
  });

  // A long page wraps the widget in `content-visibility: auto`, which sizes a
  // fixed overlay to the container instead of the viewport.
  it('renders the detail dialog outside the widget, at the document body', async () => {
    const user = userEvent.setup();
    useAlarmStore.setState({ active: [mkAlarm()], summary: mkSummary({ total: 1, unacked: 1 }) });
    const { container } = renderList();

    await user.click(screen.getByText('[A-001] Motor Overheat'));
    const ack = screen.getByRole('button', { name: 'Acknowledge' });
    expect(container).not.toContainElement(ack);
  });

  it('surfaces the configured title', () => {
    renderList({ title: 'Active Faults' });
    expect(screen.getByText('Active Faults')).toBeInTheDocument();
  });

  describe('touch options', () => {
    const cleared = {
      id: 'h-1',
      alarm_id: 'def-2',
      code: 'W-002',
      level: 'warning',
      title: 'Belt slip',
      triggered_at: '2026-01-01T09:00:00Z',
      cleared_at: '2026-01-01T09:30:00Z',
      acked: false,
      acked_by: '',
      acked_at: '',
      description: 'Tension the belt',
    };

    it('keeps today’s list when no option is set', () => {
      useAlarmStore.setState({ active: [mkAlarm()], summary: mkSummary({ unacked: 1 }) });
      const { container } = renderList();

      expect(container.querySelector('.hmi-alarm-list--touch')).toBeNull();
      expect(screen.queryByRole('group', { name: 'Show' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'ACK' })).toBeInTheDocument();
      expect(apiJson).not.toHaveBeenCalled();
    });

    it('draws touch rows as cards with the alarm state beside the time', () => {
      useAlarmStore.setState({
        active: [
          mkAlarm(),
          mkAlarm({ id: 'inst-2', code: 'A-002', title: 'Pump Fault', acked: true }),
        ],
        summary: mkSummary({ unacked: 1 }),
      });
      const { container } = renderList({ rowSize: 'touch' });

      expect(container.querySelector('.hmi-alarm-list--touch')).not.toBeNull();
      expect(screen.getByText('New')).toBeInTheDocument();
      expect(screen.getByText('Acked')).toBeInTheDocument();
    });

    it('switches between active and cleared alarms with the filter chips', async () => {
      vi.mocked(apiJson).mockImplementation(async (url: string) =>
        url.startsWith('/api/alarms/history') ? [cleared] : undefined,
      );
      const user = userEvent.setup();
      useAlarmStore.setState({ active: [mkAlarm()], summary: mkSummary({ unacked: 1 }) });
      renderList({ showFilter: true, show: 'all' });

      expect(await screen.findByText('[W-002] Belt slip')).toBeInTheDocument();
      expect(screen.getByText('[A-001] Motor Overheat')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Active (1)' }));
      expect(screen.queryByText('[W-002] Belt slip')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'History' }));
      expect(screen.queryByText('[A-001] Motor Overheat')).not.toBeInTheDocument();
      expect(screen.getByText('[W-002] Belt slip')).toBeInTheDocument();
    });

    it('shows the view the Show property names, and follows it when it changes', async () => {
      vi.mocked(apiJson).mockImplementation(async (url: string) =>
        url.startsWith('/api/alarms/history') ? [cleared] : undefined,
      );
      useAlarmStore.setState({ active: [mkAlarm()], summary: mkSummary({ unacked: 1 }) });
      const { rerender } = renderList({ show: 'history' });

      expect(await screen.findByText('[W-002] Belt slip')).toBeInTheDocument();
      expect(screen.queryByText('[A-001] Motor Overheat')).not.toBeInTheDocument();

      rerender(
        <MemoryRouter>
          <AlarmListManaged properties={{ show: 'active' }} />
        </MemoryRouter>,
      );
      expect(screen.getByText('[A-001] Motor Overheat')).toBeInTheDocument();
      expect(screen.queryByText('[W-002] Belt slip')).not.toBeInTheDocument();
    });

    it('opens the detail popup of a cleared alarm, with nothing left to acknowledge', async () => {
      vi.mocked(apiJson).mockImplementation(async (url: string) =>
        url.startsWith('/api/alarms/history') ? [cleared] : undefined,
      );
      const user = userEvent.setup();
      renderList({ show: 'history' });

      await user.click(await screen.findByText('[W-002] Belt slip'));

      expect(screen.getByText(/^Cleared:/)).toBeInTheDocument();
      expect(screen.getByText('Tension the belt')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument();
    });

    it('marks an alarm that needs no acknowledgement as active, without an ACK', () => {
      useAlarmStore.setState({
        active: [mkAlarm({ ack_required: false, acked: true })],
        summary: mkSummary(),
      });
      renderList({ rowSize: 'touch' });

      expect(screen.getByText('Active')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'ACK' })).not.toBeInTheDocument();
    });

    it('marks severity with a stripe by default, or with the row color or the icon alone', () => {
      const { container, rerender } = renderList({ rowSize: 'touch' });
      const list = () => container.querySelector('.hmi-alarm-list') as HTMLElement;
      expect(list().className).not.toMatch(/--mark-/);

      for (const mark of ['tint', 'icon']) {
        rerender(
          <MemoryRouter>
            <AlarmListManaged properties={{ rowSize: 'touch', mark }} />
          </MemoryRouter>,
        );
        expect(list()).toHaveClass(`hmi-alarm-list--mark-${mark}`);
      }
    });

    it('leaves acknowledging to a separate button when Acknowledge is off', () => {
      useAlarmStore.setState({ active: [mkAlarm()], summary: mkSummary({ unacked: 1 }) });
      renderList({ ackMode: 'off' });

      expect(screen.queryByRole('button', { name: 'ACK' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Acknowledge All' })).not.toBeInTheDocument();
    });

    it('shows the description before the time on the second line', () => {
      useAlarmStore.setState({
        active: [mkAlarm({ description: 'Check the fan' })],
        summary: mkSummary({ unacked: 1 }),
      });
      renderList({ secondLine: 'description' });

      expect(screen.getByText(/^Check the fan · /)).toBeInTheDocument();
    });
  });

  it('drops the header row, count chip included, when the title is empty', () => {
    useAlarmStore.setState({ active: [mkAlarm()], summary: mkSummary({ unacked: 1 }) });
    const { container } = renderList({ title: '' });

    expect(screen.getByText('[A-001] Motor Overheat')).toBeInTheDocument();
    const wrapper = container.querySelector('.hmi-component') as HTMLElement;
    expect(wrapper.querySelector('[class*="header"]')).toBeNull();
  });
});
