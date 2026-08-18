import '../../testSdk';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LedIndicator from './index';

function renderLed(properties: Record<string, unknown>) {
  return render(
    <MemoryRouter>
      <LedIndicator properties={properties} />
    </MemoryRouter>,
  );
}

describe('LedIndicator', () => {
  it('renders with no properties at all', () => {
    const { container } = renderLed({});
    const el = container.firstElementChild as HTMLElement;

    expect(el.className).toContain('hmi-component');
    expect(el.className).toContain('hmi-led-indicator');
    expect(el.querySelector('.hmi-led-indicator__dot')).not.toBeNull();
  });

  it('reads as off — not as on — when the value is absent', () => {
    const { container } = renderLed({ label: 'Pump' });

    expect((container.firstElementChild as HTMLElement).className).toContain(
      'hmi-led-indicator--off',
    );
    expect(screen.getByText('Pump')).toBeInTheDocument();
  });

  it('lights up on a truthy value', () => {
    const { container } = renderLed({ variable: true });

    expect((container.firstElementChild as HTMLElement).className).toContain(
      'hmi-led-indicator--on',
    );
  });
});
