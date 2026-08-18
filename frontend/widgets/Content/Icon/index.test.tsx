import '../../testSdk';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Icon from './index';

function renderIcon(properties: Record<string, unknown>) {
  return render(
    <MemoryRouter>
      <Icon properties={properties} />
    </MemoryRouter>,
  );
}

describe('Icon', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders a builtin icon by name', async () => {
    const { container } = renderIcon({ iconName: 'house', size: 32 });

    // Builtin icon components are code-split (backlog item 22) — the icon
    // resolves asynchronously behind a `Suspense fallback={null}` even when
    // its chunk is already cached. The lazy import pulls the whole
    // `phosphorIconComponents` module (all 59 icons); its first on-the-fly
    // transform on a cold CI runner — slower still under coverage-v8
    // instrumentation — can outlast waitFor's 1s default, so give it real
    // headroom. Locally this resolves in well under a second.
    await waitFor(
      () => {
        expect(container.querySelector('svg')).not.toBeNull();
      },
      { timeout: 8000 },
    );
  }, 15000);

  it('drops the chip border/background when chrome is false', async () => {
    const { container } = renderIcon({ iconName: 'house', chrome: false });

    await waitFor(() => {
      expect(container.querySelector('.hmi-icon--bare')).not.toBeNull();
    });
  });

  it('renders nothing when no icon name is set', () => {
    const { container } = renderIcon({});

    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders a custom SVG asset with colors stripped and currentColor injected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ text: async () => '<svg stroke="blue"><path/></svg>' }),
    );
    const { container } = renderIcon({ iconName: '/assets/icons/gauge.svg', color: '#0000ff' });

    await waitFor(() => {
      expect(container.querySelector('svg')).not.toBeNull();
    });
    const svg = container.querySelector('svg')!;
    expect(svg.outerHTML).not.toContain('stroke="blue"');
    expect(svg.outerHTML).toContain('currentColor');
  });
});
