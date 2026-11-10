import '../../testSdk';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useVariableStore } from '@hmi/store/variableStore';
import Icon from './index';

// test-setup.ts stubs the icon module for every other test; this one covers the
// real loader.
vi.unmock('@shared/utils/phosphorIconComponents');

function fetchedUrls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map(([url]) => String(url));
}

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
    useVariableStore.setState({ values: {} });
  });

  it('renders a builtin icon by name', async () => {
    const { container } = renderIcon({ iconName: 'house', size: 32 });

    // Builtin icon components are code-split — the icon
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

  it('turns by its Rotation through a custom property', () => {
    const { container } = renderIcon({ iconName: 'house', rotation: 90 });

    const root = container.querySelector<HTMLElement>('.hmi-icon')!;
    expect(root.style.getPropertyValue('--hmi-icon-rotation')).toBe('90deg');
  });

  it('renders nothing when no icon name is set', () => {
    const { container } = renderIcon({});

    expect(container.querySelector('svg')).toBeNull();
  });

  it('draws a custom SVG asset as a mask in its colour, without fetching its markup', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal('fetch', fetchMock);
    const { container } = renderIcon({
      iconName: '/assets/icons/gauge.svg',
      color: '#0000ff',
      size: 40,
    });

    const box = container.querySelector<HTMLElement>('.hmi-icon__svg')!;
    expect(box.style.getPropertyValue('--hmi-icon-url')).toBe('url("/assets/icons/gauge.svg")');
    expect(box.style.getPropertyValue('--hmi-icon-color')).toBe('#0000ff');
    expect(box.style.getPropertyValue('--hmi-icon-size')).toBe('40px');
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchedUrls(fetchMock).filter((url) => url.includes('/assets/'))).toEqual([]);
    expect(box.childNodes).toHaveLength(0);
  });

  it('loads a custom icon from under the proxied base', () => {
    window.__NEXTHMI_BASE__ = '/runtime/demo/';
    try {
      const { container } = renderIcon({ iconName: '/assets/icons/gauge.svg' });

      const box = container.querySelector<HTMLElement>('.hmi-icon__svg')!;
      expect(box.style.getPropertyValue('--hmi-icon-url')).toBe(
        'url("/runtime/demo/assets/icons/gauge.svg")',
      );
    } finally {
      delete window.__NEXTHMI_BASE__;
    }
  });

  // The value can come from a String tag any client may write over /ws.
  it('draws an empty box for a path that leaves the icons folder', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal('fetch', fetchMock);
    useVariableStore.setState({
      values: {
        'PLC:Icon':
          '/assets/icons/../../api/historian/query?start=-1h&variables=%3Csvg%3E%3Cimg%20src=x%20onerror=alert(1)%3E%3C/svg%3E',
      },
    });
    const { container } = renderIcon({ iconName: { $var: { path: 'PLC:Icon' } } });

    const box = container.querySelector<HTMLElement>('.hmi-icon__svg')!;
    expect(box.style.getPropertyValue('--hmi-icon-url')).toBe('');
    expect(box.childNodes).toHaveLength(0);
    expect(container.querySelector('img, svg')).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchedUrls(fetchMock).filter((url) => url.includes('historian'))).toEqual([]);
  });
});
