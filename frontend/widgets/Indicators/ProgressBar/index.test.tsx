import '../../testSdk';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ProgressBar from './index';

function renderBar(properties: Record<string, unknown>) {
  return render(
    <MemoryRouter>
      <ProgressBar properties={properties} />
    </MemoryRouter>,
  );
}

describe('ProgressBar', () => {
  it('renders with no properties at all', () => {
    const { container } = renderBar({});
    const el = container.firstElementChild as HTMLElement;

    expect(el.className).toContain('hmi-component');
    expect(el.className).toContain('hmi-progress-bar');
    expect(el.querySelector('[role="progressbar"]')).not.toBeNull();
  });

  it('renders the placeholder rather than a number when the value is absent', () => {
    const { container } = renderBar({ showValue: true, showPercent: false });

    expect(container.querySelector('.hmi-progress-bar__value')?.textContent).toBe('---');
  });

  it('emits the fill percentage as a custom property', () => {
    const { container } = renderBar({ variable: 25, min: 0, max: 200 });

    expect(
      (container.firstElementChild as HTMLElement).style.getPropertyValue(
        '--hmi-progress-bar-fill',
      ),
    ).toBe('12.5%');
  });

  it('reads full at and above the collapsed point when min equals max', () => {
    const { container } = renderBar({ variable: 5, min: 5, max: 5 });

    expect(
      (container.firstElementChild as HTMLElement).style.getPropertyValue(
        '--hmi-progress-bar-fill',
      ),
    ).toBe('100%');
  });

  it('reads empty below the collapsed point when min equals max', () => {
    const { container } = renderBar({ variable: 4, min: 5, max: 5 });

    expect(
      (container.firstElementChild as HTMLElement).style.getPropertyValue(
        '--hmi-progress-bar-fill',
      ),
    ).toBe('0%');
  });

  it('clamps a decimals value a binding pushed outside the schema range', () => {
    const low = renderBar({ variable: 12.3456, decimals: -1, showValue: true });
    expect(low.container.querySelector('.hmi-progress-bar__value')?.textContent).toBe('12');

    const high = renderBar({ variable: 12.3456, decimals: 200, showValue: true });
    expect(high.container.querySelector('.hmi-progress-bar__value')?.textContent).toBe('12.345600');
  });
});
