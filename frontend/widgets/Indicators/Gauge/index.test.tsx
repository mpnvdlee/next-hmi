import '../../testSdk';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useVariableStore } from '@hmi/store/variableStore';
import Gauge from './index';
import gaugeSource from './index.tsx?raw';

function renderGauge(properties: Record<string, unknown>) {
  return render(
    <MemoryRouter>
      <Gauge properties={properties} />
    </MemoryRouter>,
  );
}

/** Start and end coordinates of an arc path, or null when it is not one. */
function arcEnds(d: string | null | undefined): [string, string] | null {
  const match = /^M ([\d.-]+ [\d.-]+) A [\d.]+ [\d.]+ 0 [01] 1 ([\d.-]+ [\d.-]+)$/.exec(d ?? '');
  return match ? [match[1], match[2]] : null;
}

function fillEnds(container: HTMLElement) {
  return arcEnds(container.querySelector('.hmi-gauge__fill')?.getAttribute('d'));
}

describe('Gauge', () => {
  it('renders with no properties at all', () => {
    const { container } = renderGauge({});
    const el = container.firstElementChild as HTMLElement;

    expect(el.className).toContain('hmi-component');
    expect(el.className).toContain('hmi-gauge');
    expect(container.querySelector('.hmi-gauge__track')).not.toBeNull();
  });

  it('renders the placeholder rather than a number when the value is absent', () => {
    renderGauge({ label: 'Tank level' });

    expect(screen.getByText('---')).toBeInTheDocument();
  });

  it('draws no value arc at all when the value is absent', () => {
    const ends = fillEnds(renderGauge({}).container);

    expect(ends).not.toBeNull();
    expect(ends?.[0]).toBe(ends?.[1]);
  });

  it('sweeps the value arc proportionally to the range', () => {
    const half = fillEnds(renderGauge({ variable: 50 }).container);
    const full = fillEnds(renderGauge({ variable: 100 }).container);

    expect(half?.[0]).not.toBe(half?.[1]);
    expect(full?.[1]).not.toBe(half?.[1]);
  });

  it('reads an integer beyond 2**53, which arrives as its decimal string', () => {
    useVariableStore.setState({ values: { 'PLC:Counter': '9007199254740993' } });
    const { container } = renderGauge({
      variable: { $var: { path: 'PLC:Counter' } },
      max: 2 ** 54,
    });

    expect(container.querySelector('.hmi-gauge__value')?.textContent).toBe('9007199254740992.0');
    expect(fillEnds(container)).toEqual(
      fillEnds(renderGauge({ variable: 50, max: 100 }).container),
    );
  });

  // The compiler flags a widget as needing the chart chunk by looking for the
  // literal string `Recharts` in its compiled source, so the SVG arc only stays
  // free of that dependency while the identifier is genuinely absent.
  it('never reaches for the chart library', () => {
    expect(gaugeSource).not.toContain('Recharts');
  });
});
