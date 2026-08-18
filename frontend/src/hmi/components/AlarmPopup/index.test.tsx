import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { AlarmInstance, AlarmSummary } from '@shared/types/alarm';
import { useAlarmStore } from '@hmi/store/alarmStore';
import { useHmiStore } from '@hmi/store/hmiStore';
import { useTranslationStore } from '@shared/store/translationStore';
import { apiJson } from '@shared/utils/api';
import styles from './index.module.css';
import AlarmPopup from './index';

// Partial: the ack helpers reach for `errorMessage` on a refusal, so stubbing
// the whole module would fail the failure path rather than exercise it.
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

const EMPTY_SUMMARY: AlarmSummary = {
  total: 0,
  unacked: 0,
  error_count: 0,
  warning_count: 0,
  info_count: 0,
};

function renderPopup() {
  return render(
    <MemoryRouter>
      <AlarmPopup />
    </MemoryRouter>,
  );
}

describe('AlarmPopup', () => {
  beforeEach(() => {
    vi.mocked(apiJson).mockReset();
    useAlarmStore.setState({ active: [], summary: EMPTY_SUMMARY });
    useHmiStore.setState({ currentUsersByScope: {} });
  });

  it('renders nothing when there are no auto-popup alarms', () => {
    const { container } = renderPopup();
    expect(container.firstChild).toBeNull();
  });

  it('excludes acked and non-auto_popup alarms', () => {
    useAlarmStore.setState({
      active: [
        mkAlarm({ id: 'acked', acked: true, title: 'Already Acked' }),
        mkAlarm({ id: 'silent', auto_popup: false, title: 'Silent Alarm' }),
      ],
      summary: EMPTY_SUMMARY,
    });
    const { container } = renderPopup();
    expect(container.firstChild).toBeNull();
  });

  it('renders live popups for unacked auto-popup alarms', () => {
    useAlarmStore.setState({
      active: [mkAlarm(), mkAlarm({ id: 'inst-2', code: 'A-002', title: 'Pump Fault' })],
      summary: EMPTY_SUMMARY,
    });
    renderPopup();

    expect(screen.getByText('[A-001] Motor Overheat')).toBeInTheDocument();
    expect(screen.getByText('[A-002] Pump Fault')).toBeInTheDocument();
  });

  it('caps rendered popups at 5', () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      mkAlarm({ id: `inst-${i}`, code: `A-00${i}`, title: `Alarm ${i}` }),
    );
    useAlarmStore.setState({ active: many, summary: EMPTY_SUMMARY });
    const { container } = renderPopup();
    expect(container.querySelectorAll(`.${styles.popup}`)).toHaveLength(5);
  });

  it('applies the shared toast level variants', () => {
    useAlarmStore.setState({
      active: [
        mkAlarm({ level: 'error' }),
        mkAlarm({ id: 'inst-2', level: 'warning', code: 'A-002', title: 'Pump Warning' }),
        mkAlarm({ id: 'inst-3', level: 'info', code: 'A-003', title: 'Info Note' }),
      ],
      summary: EMPTY_SUMMARY,
    });
    const { container } = renderPopup();
    const popups = container.querySelectorAll(`.${styles.popup}`);
    expect(popups[0].className).toContain('hmi-toast--error');
    expect(popups[1].className).toContain('hmi-toast--warning');
    expect(popups[2].className).toContain('hmi-toast--info');
  });

  it('dismisses a popup locally without acknowledging it', async () => {
    const user = userEvent.setup();
    useAlarmStore.setState({ active: [mkAlarm()], summary: EMPTY_SUMMARY });
    const { container } = renderPopup();

    await user.click(screen.getByRole('button', { name: 'Dismiss alarm' }));

    expect(container.firstChild).toBeNull();
    expect(apiJson).not.toHaveBeenCalled();
  });

  it('acknowledges an alarm via its ACK button', async () => {
    vi.mocked(apiJson).mockResolvedValue(undefined);
    const user = userEvent.setup();
    useAlarmStore.setState({ active: [mkAlarm()], summary: EMPTY_SUMMARY });
    renderPopup();

    await user.click(screen.getByRole('button', { name: 'ACK' }));

    expect(apiJson).toHaveBeenCalledWith(
      '/api/alarms/ack/inst-1',
      expect.objectContaining({ method: 'POST', body: { username: 'operator' } }),
    );
  });

  it('opens the detail dialog on popup click and closes it', async () => {
    const user = userEvent.setup();
    useAlarmStore.setState({ active: [mkAlarm()], summary: EMPTY_SUMMARY });
    renderPopup();

    await user.click(screen.getByText('[A-001] Motor Overheat'));
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument();
  });
});

describe('AlarmPopup $loc titles', () => {
  // The backend flattens a `$loc` title to its bare key so one broadcast
  // instance stays language-agnostic (see `useAlarmText`); the language is
  // applied here, at render.
  const original = useTranslationStore.getState();

  afterEach(() => {
    useTranslationStore.setState(original, true);
  });

  function seedDictionary() {
    useTranslationStore.setState({
      languages: [{ code: 'en' }, { code: 'nl' }],
      translations: { 'alarm.overheat': { en: 'Motor Overheat', nl: 'Motor Oververhit' } },
      activeLanguage: 'nl',
    });
  }

  it('renders the translation for a title that arrived as a $loc key', () => {
    seedDictionary();
    useAlarmStore.setState({
      active: [mkAlarm({ title: 'alarm.overheat' })],
      summary: EMPTY_SUMMARY,
    });
    render(
      <MemoryRouter>
        <AlarmPopup />
      </MemoryRouter>,
    );

    expect(screen.getByText(/Motor Oververhit/)).toBeInTheDocument();
    expect(screen.queryByText(/alarm\.overheat/)).not.toBeInTheDocument();
  });

  it('leaves a literal title untouched when no dictionary entry matches', () => {
    seedDictionary();
    useAlarmStore.setState({
      active: [mkAlarm({ title: 'Tank B level low' })],
      summary: EMPTY_SUMMARY,
    });
    render(
      <MemoryRouter>
        <AlarmPopup />
      </MemoryRouter>,
    );

    expect(screen.getByText(/Tank B level low/)).toBeInTheDocument();
  });

  it('falls back to the key in the base language, where keys are the text', () => {
    seedDictionary();
    useTranslationStore.setState({ activeLanguage: 'en' });
    useAlarmStore.setState({
      active: [mkAlarm({ title: 'alarm.overheat' })],
      summary: EMPTY_SUMMARY,
    });
    render(
      <MemoryRouter>
        <AlarmPopup />
      </MemoryRouter>,
    );

    expect(screen.getByText(/alarm\.overheat/)).toBeInTheDocument();
  });
});
