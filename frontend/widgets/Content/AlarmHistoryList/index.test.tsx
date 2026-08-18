import '../../testSdk';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AlarmHistoryEntry, AlarmInstance } from '@shared/types/alarm';
import { useAlarmStore } from '@hmi/store/alarmStore';
import { apiJson } from '@shared/utils/api';
import AlarmHistoryList from './index';

vi.mock('@shared/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/utils/api')>()),
  apiJson: vi.fn(),
}));

function mkEntry(overrides: Partial<AlarmHistoryEntry> = {}): AlarmHistoryEntry {
  return {
    id: 'h-1',
    alarm_id: 'def-1',
    code: 'A-001',
    level: 'error',
    title: 'Motor Overheat',
    group_title: 'Motors',
    triggered_at: '2026-01-01T10:00:00Z',
    cleared_at: '2026-01-01T10:05:00Z',
    acked: false,
    acked_by: '',
    acked_at: '',
    ...overrides,
  };
}

const EMPTY_SUMMARY = { total: 0, unacked: 0, error_count: 0, warning_count: 0, info_count: 0 };

describe('AlarmHistoryList', () => {
  beforeEach(() => {
    vi.mocked(apiJson).mockReset();
    useAlarmStore.setState({ active: [], summary: EMPTY_SUMMARY });
  });

  it('shows a loading state before the fetch resolves', () => {
    vi.mocked(apiJson).mockReturnValue(new Promise(() => {}));
    render(
      <MemoryRouter>
        <AlarmHistoryList properties={{}} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('shows an empty state when the history has no entries', async () => {
    vi.mocked(apiJson).mockResolvedValue([]);
    render(
      <MemoryRouter>
        <AlarmHistoryList properties={{}} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('No alarm history')).toBeInTheDocument());
  });

  it('falls back to an empty state without crashing when the fetch fails', async () => {
    vi.mocked(apiJson).mockRejectedValue(new Error('network down'));
    render(
      <MemoryRouter>
        <AlarmHistoryList properties={{}} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('No alarm history')).toBeInTheDocument());
  });

  it('renders history rows with code, title, time range, and ack status', async () => {
    vi.mocked(apiJson).mockResolvedValue([
      mkEntry({ acked: true, acked_by: 'jdoe' }),
      mkEntry({ id: 'h-2', code: 'A-002', title: 'Pump Fault', acked: false }),
    ]);
    render(
      <MemoryRouter>
        <AlarmHistoryList properties={{}} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('[A-001] Motor Overheat')).toBeInTheDocument());
    expect(screen.getByText('[A-002] Pump Fault')).toBeInTheDocument();
    expect(screen.getByText('ACK: jdoe')).toBeInTheDocument();
    expect(screen.getByText('Not acked')).toBeInTheDocument();
  });

  it('renders the configured title', async () => {
    vi.mocked(apiJson).mockResolvedValue([]);
    render(
      <MemoryRouter>
        <AlarmHistoryList properties={{ title: 'Fault Log' }} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Fault Log')).toBeInTheDocument();
  });

  it('drops the header row when the title is empty', async () => {
    vi.mocked(apiJson).mockResolvedValue([mkEntry()]);
    const { container } = render(
      <MemoryRouter>
        <AlarmHistoryList properties={{ title: '' }} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText(/Motor Overheat/)).toBeInTheDocument());
    const wrapper = container.querySelector('.hmi-component') as HTMLElement;
    expect(wrapper.querySelector('[class*="header"]')).toBeNull();
  });

  it('filters entries client-side by filterLevel and requests maxRows via the API', async () => {
    vi.mocked(apiJson).mockResolvedValue([
      mkEntry({ id: 'h-err', level: 'error' }),
      mkEntry({ id: 'h-warn', level: 'warning', code: 'A-002', title: 'Pump Warning' }),
    ]);
    render(
      <MemoryRouter>
        <AlarmHistoryList properties={{ filterLevel: 'warning', maxRows: 50 }} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('[A-002] Pump Warning')).toBeInTheDocument());
    expect(screen.queryByText('[A-001] Motor Overheat')).not.toBeInTheDocument();
    expect(apiJson).toHaveBeenCalledWith('/api/alarms/history?limit=50');
  });

  it('re-fetches history when the active alarm list changes', async () => {
    vi.mocked(apiJson).mockResolvedValue([]);
    render(
      <MemoryRouter>
        <AlarmHistoryList properties={{}} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(apiJson).toHaveBeenCalledTimes(1));

    useAlarmStore.setState({
      active: [
        {
          id: 'inst-1',
          alarm_id: 'def-1',
          code: 'A-001',
          level: 'error',
          title: 'Motor Overheat',
          description: '',
          image: '',
          resolutions: [],
          group_title: 'Motors',
          auto_popup: false,
          ack_groups: [],
          triggered_at: '2026-01-01T10:00:00Z',
          acked: false,
          acked_by: '',
          acked_at: '',
        } satisfies AlarmInstance,
      ],
      summary: EMPTY_SUMMARY,
    });

    await waitFor(() => expect(apiJson).toHaveBeenCalledTimes(2));
  });
});
