import '../../testSdk';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import RingGauge from './index';

function renderRing(properties: Record<string, unknown>) {
  return render(
    <MemoryRouter>
      <RingGauge properties={properties} />
    </MemoryRouter>,
  );
}

describe('RingGauge', () => {
  it('renders with no properties at all', () => {
    const { container } = renderRing({});
    const el = container.firstElementChild as HTMLElement;

    expect(el.className).toContain('hmi-component');
    expect(el.className).toContain('hmi-ring-gauge');
    expect(container.querySelector('.hmi-ring-gauge__hole')).not.toBeNull();
  });

  it('renders the placeholder rather than a number when the value is absent', () => {
    const { container } = renderRing({ caption: 'OEE' });

    expect(container.querySelector('.hmi-ring-gauge__value')?.textContent).toBe('---%');
    expect(screen.getByText('OEE')).toBeInTheDocument();
  });

  it('carries the diameter, hole and swept angle as custom properties', () => {
    const { container } = renderRing({ value: 25, size: 200, thickness: 20 });
    const el = container.firstElementChild as HTMLElement;

    expect(el.style.getPropertyValue('--hmi-ring-gauge-size')).toBe('200px');
    expect(el.style.getPropertyValue('--hmi-ring-gauge-hole')).toBe('160px');
    expect(el.style.getPropertyValue('--hmi-ring-gauge-sweep')).toBe('90.00deg');
  });

  it('leaves the ring colour unset so the CSS falls back to the accent token', () => {
    const { container } = renderRing({ value: 10 });

    expect(
      (container.firstElementChild as HTMLElement).style.getPropertyValue('--hmi-ring-gauge-color'),
    ).toBe('');
  });

  it('clamps a decimals value a binding pushed outside the schema range', () => {
    const low = renderRing({ value: 12.3456, decimals: -1 });
    expect(low.container.querySelector('.hmi-ring-gauge__value')?.textContent).toBe('12%');

    const high = renderRing({ value: 12.3456, decimals: 200 });
    expect(high.container.querySelector('.hmi-ring-gauge__value')?.textContent).toBe('12.346%');
  });
});
