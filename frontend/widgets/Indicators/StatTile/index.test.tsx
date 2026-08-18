import '../../testSdk';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import StatTile from './index';

function renderTile(properties: Record<string, unknown>) {
  return render(
    <MemoryRouter>
      <StatTile properties={properties} />
    </MemoryRouter>,
  );
}

describe('StatTile', () => {
  it('renders with no properties at all', () => {
    const { container } = renderTile({});
    const el = container.firstElementChild as HTMLElement;

    expect(el.className).toContain('hmi-component');
    expect(el.className).toContain('hmi-stat-tile');
    expect(el.className).toContain('hmi-stat-tile--row');
  });

  it('renders the placeholder rather than an empty reading when the value is absent', () => {
    renderTile({ label: 'Throughput', unit: 'u/h' });

    expect(screen.getByText('---')).toBeInTheDocument();
    expect(screen.getByText('u/h')).toBeInTheDocument();
  });

  it('tints the number in stacked layout and leaves it plain in row layout', () => {
    const stacked = renderTile({ value: '92', size: 'stacked', tone: 'warn' });
    expect(stacked.container.querySelector('.hmi-stat-tile__num')?.className).toContain(
      'hmi-stat-tile__num--warn',
    );

    const row = renderTile({ value: '92', size: 'row', tone: 'warn' });
    expect(row.container.querySelector('.hmi-stat-tile__num')?.className).not.toContain(
      'hmi-stat-tile__num--warn',
    );
  });

  it('falls back to the row layout and accent tone for unknown values', () => {
    const { container } = renderTile({ size: 'sideways', tone: 'chartreuse' });
    const el = container.firstElementChild as HTMLElement;

    expect(el.className).toContain('hmi-stat-tile--row');
    expect(el.className).not.toContain('hmi-stat-tile--sideways');
  });
});
