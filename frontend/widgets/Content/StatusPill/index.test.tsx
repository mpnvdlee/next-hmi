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
    // Same code-split icon path as the Icon widget: the lazy import pulls the
    // whole `phosphorIconComponents` module, whose first on-the-fly transform
    // can outlast waitFor's 1s default when the suite runs in parallel. See
    // the fuller note in ../Icon/index.test.tsx.
    await waitFor(
      () => {
        expect(container.querySelector('svg')).not.toBeNull();
      },
      { timeout: 8000 },
    );
    expect(container.querySelector('i')).toBeNull();
  }, 15000);

  it('applies the tone class matching the tone property', () => {
    const { container } = renderPill({ text: 'Fault', tone: 'fault' });
    expect(container.querySelector('.hmi-status-pill')?.className).toContain(
      'hmi-status-pill--fault',
    );
  });
});
