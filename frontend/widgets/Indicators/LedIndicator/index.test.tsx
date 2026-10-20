import '../../testSdk';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useVariableStore } from '@hmi/store/variableStore';
import LedIndicator from './index';

function renderLed(properties: Record<string, unknown>) {
  return render(
    <MemoryRouter>
      <LedIndicator properties={properties} />
    </MemoryRouter>,
  );
}

describe('LedIndicator', () => {
  beforeEach(() => {
    useVariableStore.setState({ values: {}, varMeta: {} });
  });

  it('renders with no properties at all', () => {
    const { container } = renderLed({});
    const el = container.firstElementChild as HTMLElement;

    expect(el.className).toContain('hmi-component');
    expect(el.className).toContain('hmi-led-indicator');
    expect(el.querySelector('.hmi-led-indicator__dot')).not.toBeNull();
  });

  it('reads as unknown — neither on nor off — when the value is absent', () => {
    const { container } = renderLed({ label: 'Pump' });
    const el = container.firstElementChild as HTMLElement;

    expect(el.className).toContain('hmi-led-indicator--unknown');
    expect(el.className).not.toContain('hmi-led-indicator--off');
    expect(el.className).not.toContain('hmi-led-indicator--on');
    expect(screen.getByText('Pump')).toBeInTheDocument();
  });

  it('lights up on a truthy value', () => {
    const { container } = renderLed({ variable: true });

    expect((container.firstElementChild as HTMLElement).className).toContain(
      'hmi-led-indicator--on',
    );
  });

  it('reads as off on a false value', () => {
    const { container } = renderLed({ variable: false });

    expect((container.firstElementChild as HTMLElement).className).toContain(
      'hmi-led-indicator--off',
    );
  });

  it('shows unknown until a bound value arrives, then follows it', () => {
    const { container } = renderLed({ variable: { $var: { path: 'PLC:Pump/Running' } } });
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain('hmi-led-indicator--unknown');

    act(() => useVariableStore.getState().setScalar('PLC:Pump/Running', true));
    expect(el.className).toContain('hmi-led-indicator--on');
    act(() => useVariableStore.getState().setScalar('PLC:Pump/Running', 'false'));
    expect(el.className).toContain('hmi-led-indicator--off');
  });
});
