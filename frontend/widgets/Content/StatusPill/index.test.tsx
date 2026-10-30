import '../../testSdk';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import StatusPill from './index';

function renderPill(properties: Record<string, unknown>) {
  return render(
    <MemoryRouter>
      <StatusPill properties={properties} />
    </MemoryRouter>,
  );
}

describe('StatusPill', () => {
  it('renders its text', () => {
    renderPill({ text: 'Idle' });
    expect(screen.getByText('Idle')).toBeInTheDocument();
  });

  it('renders sub text as a second line', () => {
    const { container } = renderPill({ text: 'Running', subText: 'Batch 41' });
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(container.querySelector('.hmi-status-pill__subtext')?.textContent).toBe('Batch 41');
  });

  it('omits the sub text line when the property is empty', () => {
    const { container } = renderPill({ text: 'Running' });
    expect(container.querySelector('.hmi-status-pill__subtext')).toBeNull();
  });

  it('renders a pulsing dot when pulse is true', () => {
    const { container } = renderPill({ text: 'Measuring…', pulse: true, tone: 'accent' });
    expect(container.querySelector('i')).not.toBeNull();
  });

  it('renders an icon instead of the dot when not pulsing', async () => {
    const { container } = renderPill({ text: 'Completed', iconName: 'check-circle', tone: 'ok' });
    await waitFor(() => {
      expect(container.querySelector('svg')).not.toBeNull();
    });
    expect(container.querySelector('i')).toBeNull();
  });

  it('emits the radius override as a custom property, not a literal style', () => {
    const { container } = renderPill({ text: 'Idle', radius: '4px' });
    const el = container.firstElementChild as HTMLElement;

    expect(el.style.getPropertyValue('--hmi-status-pill-radius')).toBe('4px');
  });

  it('leaves the radius override unset when no radius is configured', () => {
    const { container } = renderPill({ text: 'Idle' });
    const el = container.firstElementChild as HTMLElement;

    expect(el.style.getPropertyValue('--hmi-status-pill-radius')).toBe('');
  });

  it('applies the tone class matching the tone property', () => {
    const { container } = renderPill({ text: 'Fault', tone: 'fault' });
    expect(container.querySelector('.hmi-status-pill')?.className).toContain(
      'hmi-status-pill--fault',
    );
  });
});
