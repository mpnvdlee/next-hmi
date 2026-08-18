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

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument();
  });

  it('surfaces the configured title', () => {
    renderList({ title: 'Active Faults' });
    expect(screen.getByText('Active Faults')).toBeInTheDocument();
  });

  it('drops the header row, count chip included, when the title is empty', () => {
    useAlarmStore.setState({ active: [mkAlarm()], summary: mkSummary({ unacked: 1 }) });
    const { container } = renderList({ title: '' });

    expect(screen.getByText('[A-001] Motor Overheat')).toBeInTheDocument();
    const wrapper = container.querySelector('.hmi-component') as HTMLElement;
    expect(wrapper.querySelector('[class*="header"]')).toBeNull();
  });
});
