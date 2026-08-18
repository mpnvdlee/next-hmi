import '../../testSdk';
import { render, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useVariableStore } from '@hmi/store/variableStore';
import Trend from './index';

// A stdlib widget reads the chart library off the SDK global, not from a module
// import, so `vi.mock('recharts')` would never be consulted. Overwrite the
// global instead — jsdom measures ResponsiveContainer at 0×0, so the real
// library would render no chart for the assertions to look at.
(globalThis as Record<string, unknown>).Recharts = {
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LineChart: ({ children, data }: { children: ReactNode; data: unknown[] }) => (
    <div data-testid="line-chart" data-points={data.length}>
      {children}
    </div>
  ),
  Line: ({ dataKey }: { dataKey: string }) => <div data-testid={`line-${dataKey}`} />,
  XAxis: () => null,
  YAxis: () => null,
};

const VAR = 'PLC:Kpi/Bph';
const BINDING = { $var: { path: VAR } };

function renderTrend(properties: Record<string, unknown>) {
  return render(
    <MemoryRouter>
      <Trend properties={properties} />
    </MemoryRouter>,
  );
}

describe('Trend', () => {
  beforeEach(() => {
    useVariableStore.setState({ values: {}, varMeta: {} });
  });

  it('renders with no properties at all', () => {
    const { container } = renderTrend({});
    const el = container.firstElementChild as HTMLElement;

    expect(el.className).toContain('hmi-component');
    expect(el.className).toContain('hmi-trend');
    expect(container.querySelector('.hmi-trend__value')?.textContent).toBe('---');
  });

  it('shows the current reading and its unit under the line', () => {
    useVariableStore.setState({ values: { [VAR]: 1206.4 } });
    const { container } = renderTrend({ variable: BINDING, unit: 'bph', decimals: 0 });

    expect(container.querySelector('.hmi-trend__value')?.textContent).toBe('1206');
    expect(container.querySelector('.hmi-trend__unit')?.textContent).toBe('bph');
  });

  it('buffers each new value and drops the oldest past the history length', () => {
    useVariableStore.setState({ values: { [VAR]: 1 } });
    const { container } = renderTrend({ variable: BINDING, historyLength: 3 });
    const points = () => container.querySelector('[data-testid="line-chart"]')?.dataset.points;

    expect(points()).toBe('1');

    for (const v of [2, 3, 4]) {
      act(() => {
        useVariableStore.setState({ values: { [VAR]: v } });
      });
    }

    expect(points()).toBe('3');
  });

  it('ignores a non-numeric value rather than plotting it', () => {
    useVariableStore.setState({ values: { [VAR]: 'offline' } });
    const { container } = renderTrend({ variable: BINDING });

    expect(container.querySelector('[data-testid="line-chart"]')?.dataset.points).toBe('0');
    expect(container.querySelector('.hmi-trend__value')?.textContent).toBe('---');
  });

  it('clamps a decimals value a binding pushed outside the schema range', () => {
    useVariableStore.setState({ values: { [VAR]: 1.23456789 } });
    const { container } = renderTrend({ variable: BINDING, decimals: 42 });

    expect(container.querySelector('.hmi-trend__value')?.textContent).toBe('1.234568');
  });
});
