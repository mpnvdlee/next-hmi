import '../../testSdk';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Clock from './index';

function renderClock(properties: Record<string, unknown>) {
  return render(
    <MemoryRouter>
      <Clock properties={properties} />
    </MemoryRouter>,
  );
}

describe('Clock', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders without throwing on empty properties', () => {
    const { container } = renderClock({});
    expect(container.firstElementChild).not.toBeNull();
  });

  it('carries the base component class alongside its own', () => {
    const { container } = renderClock({});
    const el = container.firstElementChild as HTMLElement;

    expect(el.classList.contains('hmi-component')).toBe(true);
    expect(el.classList.contains('hmi-clock')).toBe(true);
  });

  it('advances the displayed time once a second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-05-01T08:30:00Z'));
    renderClock({ timezone: 'UTC' });

    expect(screen.getByText('08:30:00')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(screen.getByText('08:30:03')).toBeInTheDocument();
  });

  it('formats with the configured pattern and time zone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-05-01T08:30:00Z'));
    renderClock({ format: 'YYYY-MM-DD HH:mm', timezone: 'UTC' });

    expect(screen.getByText('2024-05-01 08:30')).toBeInTheDocument();
  });

  it('shows the value override instead of the clock when one resolves', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-05-01T08:30:00Z'));
    renderClock({ value: 'Shift A', timezone: 'UTC' });

    expect(screen.getByText('Shift A')).toBeInTheDocument();
    expect(screen.queryByText('08:30:00')).toBeNull();
  });
});
