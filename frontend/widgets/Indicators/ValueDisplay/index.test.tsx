import '../../testSdk';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ValueDisplay from './index';

function renderValue(properties: Record<string, unknown>) {
  return render(
    <MemoryRouter>
      <ValueDisplay properties={properties} />
    </MemoryRouter>,
  );
}

describe('ValueDisplay', () => {
  it('renders with no properties at all', () => {
    const { container } = renderValue({});
    const el = container.firstElementChild as HTMLElement;

    expect(el.className).toContain('hmi-component');
    expect(el.className).toContain('hmi-value-display');
  });

  it('renders the placeholder rather than a number when the value is absent', () => {
    renderValue({ label: 'Flow', unit: 'l/min' });

    expect(screen.getByText('---')).toBeInTheDocument();
    expect(screen.getByText('l/min')).toBeInTheDocument();
  });

  it('formats a numeric value to the configured decimals', () => {
    renderValue({ variable: 12.3456, decimals: 2 });

    expect(screen.getByText('12.35')).toBeInTheDocument();
  });

  it('stringifies a non-numeric value rather than showing NaN', () => {
    renderValue({ variable: true });

    expect(screen.getByText('true')).toBeInTheDocument();
  });

  it('clamps a decimals value a binding pushed outside the schema range', () => {
    expect(renderValue({ variable: 12.3456, decimals: -1 }).container.textContent).toBe('12');
    expect(renderValue({ variable: 12.3456, decimals: 200 }).container.textContent).toBe(
      '12.345600',
    );
  });
});
